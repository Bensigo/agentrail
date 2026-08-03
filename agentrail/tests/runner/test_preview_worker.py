"""Tests for the out-of-process preview-boot worker
(agentrail/runner/preview_worker.py, B2b Task 7).

Hermetic throughout -- no real server, no real waits, no real processes.
Every seam the worker touches is injected:

  - ``transport`` -- a ``FakeTransport`` that scripts CLAIM responses in
    order and records every call (claim polls AND report posts) verbatim,
    so the exact report SEQUENCE (the state machine under test) can be
    asserted by filtering for the report path.
  - ``sleep`` / ``now`` -- a ``FakeClock`` (and its exploding variant for
    the crash-safety test) so TTL/liveness timing is deterministic and
    instant.
  - ``clone`` / ``detect_recipe`` / ``boot`` / ``teardown`` -- a
    ``FakeBootOps`` bundle that records every call and lets each test
    script the one outcome it cares about (a handle / a ``BootError`` /
    ``None`` recipe), without ever touching the network or spawning a real
    process.

The five lettered scenarios below are exactly the plan's own transition
matrix: (a) happy path, (b) no recipe, (c) boot error, (d) TTL boundary,
(e) an unexpected exception mid-supervise. A few more (clone failure, idle
polling, a transient claim-transport error, and main()'s own gating) round
out the state machine and the config surface.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from typing import Any, Dict, List, Optional

from agentrail.runner import preview_worker
from agentrail.runner.preview_worker import Response
from agentrail.sandbox.preview_boot import BootError, BootHandle
from agentrail.sandbox.preview_recipe import PreviewRecipe

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeTransport:
    """Scripts CLAIM responses in order (an entry may be an ``Exception``
    instance, raised instead of returned -- simulates a transport-level
    failure); auto-acks every REPORT call with a 200. Records every call
    verbatim so tests can inspect exactly what was sent."""

    def __init__(self, claim_responses: Optional[List[Any]] = None) -> None:
        self._claim_responses: List[Any] = list(claim_responses or [])
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, method: str, url: str, *, headers: Dict[str, str],
                 body: Optional[bytes] = None) -> Response:
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        if url.endswith(preview_worker.CLAIM_PATH):
            if not self._claim_responses:
                raise AssertionError("no scripted claim response left")
            resp = self._claim_responses.pop(0)
            if isinstance(resp, Exception):
                raise resp
            return resp
        if url.endswith(preview_worker.REPORT_PATH):
            return Response(status=200, body=b'{"ok":true}')
        raise AssertionError(f"unexpected transport call: {method} {url}")  # pragma: no cover


def _report_bodies(transport: FakeTransport) -> List[Dict[str, Any]]:
    return [
        json.loads(c["body"].decode("utf-8"))
        for c in transport.calls
        if c["url"].endswith(preview_worker.REPORT_PATH)
    ]


def _report_statuses(transport: FakeTransport) -> List[str]:
    return [b["status"] for b in _report_bodies(transport)]


class FakeClock:
    """``now()`` reads a counter; ``sleep(s)`` advances it by ``s`` and
    records the call -- a virtual clock so TTL/liveness math is exact and
    instant."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start
        self.sleeps: List[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


class ExplodingSleepClock(FakeClock):
    """Like ``FakeClock``, but ``sleep()`` raises on the ``boom_on_call``'th
    invocation instead of advancing the clock -- simulates a genuinely
    unexpected failure partway through the supervise loop."""

    def __init__(self, boom_on_call: int, start: float = 0.0) -> None:
        super().__init__(start)
        self._boom_on_call = boom_on_call
        self._calls = 0

    def sleep(self, seconds: float) -> None:
        self._calls += 1
        if self._calls == self._boom_on_call:
            raise RuntimeError("simulated unexpected failure mid-supervise")
        super().sleep(seconds)


_RECIPE = PreviewRecipe(install=["npm", "ci"], start=["npm", "run", "dev"], port=3000, ready_path="/")


def _fake_handle(dest: str) -> BootHandle:
    return BootHandle(
        proc=None,  # type: ignore[arg-type]
        pgid=-1,
        port=3000,
        url="http://127.0.0.1:3000",
        clone_dir=dest,
        boot_log_path=os.path.join(dest, ".agentrail-preview-boot.log"),
    )


class FakeBootOps:
    """Records every clone/detect_recipe/boot/teardown call; each test
    configures the one outcome it cares about via the constructor."""

    def __init__(
        self,
        *,
        recipe: Optional[PreviewRecipe] = _RECIPE,
        boot_raises: Optional[BootError] = None,
        boot_removes_dir: bool = False,
        clone_raises: Optional[Exception] = None,
    ) -> None:
        self.clone_calls: List[Dict[str, Any]] = []
        self.detect_calls: List[str] = []
        self.boot_calls: List[Dict[str, Any]] = []
        self.teardown_calls: List[BootHandle] = []
        self._recipe = recipe
        self._boot_raises = boot_raises
        self._boot_removes_dir = boot_removes_dir
        self._clone_raises = clone_raises

    def clone(self, repo_url: str, ref: str, dest: str, *, token: str, timeout: float = 120.0) -> None:
        self.clone_calls.append({"repo_url": repo_url, "ref": ref, "dest": dest, "token": token})
        if self._clone_raises is not None:
            raise self._clone_raises

    def detect_recipe(self, repo_dir: str) -> Optional[PreviewRecipe]:
        self.detect_calls.append(repo_dir)
        return self._recipe

    def boot(self, recipe: PreviewRecipe, clone_dir: str, *, advertise_host: str,
             process_env: dict, timeout: float) -> BootHandle:
        self.boot_calls.append(
            {
                "recipe": recipe,
                "clone_dir": clone_dir,
                "advertise_host": advertise_host,
                "process_env": dict(process_env),
                "timeout": timeout,
            }
        )
        if self._boot_raises is not None:
            if self._boot_removes_dir:
                # Mirrors preview_boot.boot()'s own documented contract: by
                # the time BootError is raised, it has ALREADY cleaned up
                # everything it started for this attempt -- no leaked
                # process, no leftover clone_dir. A faithful fake simulates
                # that, rather than exercising a fake that violates the
                # real module's contract.
                shutil.rmtree(clone_dir, ignore_errors=True)
            raise self._boot_raises
        os.makedirs(clone_dir, exist_ok=True)
        with open(os.path.join(clone_dir, ".agentrail-preview-boot.log"), "w", encoding="utf-8") as fh:
            fh.write("server ready\n")
        return _fake_handle(clone_dir)

    def teardown(self, handle: BootHandle) -> None:
        self.teardown_calls.append(handle)
        shutil.rmtree(handle.clone_dir, ignore_errors=True)  # mirrors the real teardown's effect


def _claim_item_dict(**overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "id": "pb-1",
        "workspaceId": "ws-1",
        "repo": "acme/widgets",
        "repoUrl": "https://github.com/acme/widgets",
        "prNumber": 42,
        "headSha": "deadbeefcafe1234",
        "ref": "deadbeefcafe1234",
        "githubToken": "ghtok",
        "ttlSeconds": 100,
        "baseRef": "origin/main",
        "expectedHeadSha": "deadbeefcafe1234",
        "expectedEnvironmentRung": "preview",
    }
    base.update(overrides)
    return base


def _claim_response(**overrides: Any) -> Response:
    return Response(status=200, body=json.dumps(_claim_item_dict(**overrides)).encode("utf-8"))


def _no_item_response() -> Response:
    return Response(status=204, body=b"")


def _config(**overrides: Any) -> preview_worker.WorkerConfig:
    base = dict(base_url="https://console.test", token="tok", advertise_host="127.0.0.1", worker_id="worker-1")
    base.update(overrides)
    return preview_worker.WorkerConfig(**base)


def _stop_after(n: int):
    """Mirrors agentrail/tests/runner/test_worker.py's own bounding idiom:
    lets the claim loop run exactly ``n`` top-level iterations, then exit."""
    calls = {"n": 0}

    def should_continue() -> bool:
        calls["n"] += 1
        return calls["n"] <= n

    return should_continue


# ---------------------------------------------------------------------------
# (a) happy path: booting -> ready -> [liveness ready...] -> torn_down
# ---------------------------------------------------------------------------


def test_happy_path_report_sequence():
    clock = FakeClock()
    ops = FakeBootOps()
    transport = FakeTransport([_claim_response(ttlSeconds=100)])
    config = _config()

    preview_worker.run_preview_worker(
        config,
        transport=transport,
        sleep=clock.sleep,
        now=clock.now,
        clone=ops.clone,
        detect_recipe=ops.detect_recipe,
        boot=ops.boot,
        teardown=ops.teardown,
        liveness_interval=30.0,
        should_continue=_stop_after(1),
    )

    # ttl=100, interval=30: sleeps land at t=30,60,90 (each < 100 -> a
    # liveness "ready"), then t=120 (>= 100 -> stop, no extra ready).
    assert _report_statuses(transport) == ["booting", "ready", "ready", "ready", "ready", "torn_down"]
    assert clock.sleeps == [30.0, 30.0, 30.0, 30.0]

    assert len(ops.boot_calls) == 1
    assert ops.boot_calls[0]["advertise_host"] == "127.0.0.1"
    assert ops.boot_calls[0]["timeout"] == preview_worker.BOOT_TIMEOUT_SECONDS
    assert len(ops.teardown_calls) == 1
    assert ops.teardown_calls[0].url == "http://127.0.0.1:3000"


def test_happy_path_propagates_claim_identity_into_the_boot_child_env():
    clock = FakeClock()
    ops = FakeBootOps()
    transport = FakeTransport([_claim_response()])
    config = _config()

    preview_worker.run_preview_worker(
        config,
        transport=transport,
        sleep=clock.sleep,
        now=clock.now,
        clone=ops.clone,
        detect_recipe=ops.detect_recipe,
        boot=ops.boot,
        teardown=ops.teardown,
        liveness_interval=30.0,
        should_continue=_stop_after(1),
    )

    boot_env = ops.boot_calls[0]["process_env"]
    assert boot_env["AGENTRAIL_WORKSPACE_ID"] == "ws-1"
    assert boot_env["AGENTRAIL_BASE_REF"] == "origin/main"
    assert boot_env["AGENTRAIL_EXPECTED_HEAD_SHA"] == "deadbeefcafe1234"
    assert boot_env["AGENTRAIL_EXPECTED_ENVIRONMENT_RUNG"] == "preview"
    # The preview boot/report shape is unchanged: the new evidence is
    # carried through the boot plane without changing the human-facing
    # claim/report semantics.
    assert _report_statuses(transport) == ["booting", "ready", "ready", "ready", "ready", "torn_down"]


def test_claim_identity_mismatch_fails_closed_before_booting():
    clock = FakeClock()
    ops = FakeBootOps()
    transport = FakeTransport([
        _claim_response(expectedHeadSha="different-deadbeef"),
    ])
    config = _config()

    preview_worker.run_preview_worker(
        config,
        transport=transport,
        sleep=clock.sleep,
        now=clock.now,
        clone=ops.clone,
        detect_recipe=ops.detect_recipe,
        boot=ops.boot,
        teardown=ops.teardown,
        liveness_interval=30.0,
        should_continue=_stop_after(1),
    )

    assert _report_statuses(transport) == ["failed"]
    assert _report_bodies(transport)[0]["reason"] == "claim expectedHeadSha does not match headSha"
    assert ops.clone_calls == []
    assert ops.boot_calls == []

    # claim + every report are addressed to THIS worker and bearer-authed.
    claim_call = transport.calls[0]
    assert claim_call["headers"]["Authorization"] == "Bearer tok"
    assert json.loads(claim_call["body"]) == {"workerId": "worker-1"}
    assert all(b["workerId"] == "worker-1" and b["id"] == "pb-1" for b in _report_bodies(transport))


# ---------------------------------------------------------------------------
# (b) no recipe: booting -> failed; no boot attempted; dir cleaned
# ---------------------------------------------------------------------------


def test_no_recipe_reports_failed_and_cleans_dir_without_booting():
    clock = FakeClock()
    ops = FakeBootOps(recipe=None)
    transport = FakeTransport([_claim_response()])
    config = _config()

    preview_worker.run_preview_worker(
        config, transport=transport, sleep=clock.sleep, now=clock.now,
        clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
        should_continue=_stop_after(1),
    )

    assert _report_statuses(transport) == ["booting", "failed"]
    assert _report_bodies(transport)[1]["reason"] == "no recipe"
    assert ops.boot_calls == []
    assert ops.teardown_calls == []
    dest = ops.clone_calls[0]["dest"]
    assert ops.detect_calls == [dest]
    assert not os.path.isdir(dest)  # cleaned up by the worker itself


# ---------------------------------------------------------------------------
# (c) boot error: booting -> failed; trusts boot()'s own cleanup contract
# ---------------------------------------------------------------------------


def test_boot_error_reports_failed_and_trusts_boots_own_cleanup():
    clock = FakeClock()
    boot_exc = BootError(
        "child never became healthy: connection refused",
        boot_log_tail="listening failed\nconnection refused",
    )
    ops = FakeBootOps(boot_raises=boot_exc, boot_removes_dir=True)
    transport = FakeTransport([_claim_response()])
    config = _config()

    preview_worker.run_preview_worker(
        config, transport=transport, sleep=clock.sleep, now=clock.now,
        clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
        should_continue=_stop_after(1),
    )

    assert _report_statuses(transport) == ["booting", "failed"]
    failed_body = _report_bodies(transport)[1]
    assert failed_body["reason"] == "boot_failed"
    assert failed_body["bootLog"] == "listening failed\nconnection refused"
    # preview_boot.boot()'s own docstring: "callers never need a
    # compensating teardown of their own on this path" -- there is no
    # BootHandle to tear down here in the first place (boot() raised
    # instead of returning one), so the worker must not call teardown().
    assert ops.teardown_calls == []
    dest = ops.boot_calls[0]["clone_dir"]
    assert not os.path.isdir(dest)  # removed by boot() itself (simulated), not by this worker


# ---------------------------------------------------------------------------
# (d) TTL: torn_down fires exactly when now() >= deadline (exact boundary)
# ---------------------------------------------------------------------------


def test_ttl_teardown_fires_exactly_at_deadline():
    clock = FakeClock()
    ops = FakeBootOps()
    # ttl=90 is an EXACT multiple of interval=30 -- the tightest boundary:
    # the 3rd sleep lands precisely ON the deadline (90 >= 90), which must
    # stop the loop WITHOUT one more liveness report.
    transport = FakeTransport([_claim_response(ttlSeconds=90)])
    config = _config()

    preview_worker.run_preview_worker(
        config, transport=transport, sleep=clock.sleep, now=clock.now,
        clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
        liveness_interval=30.0,
        should_continue=_stop_after(1),
    )

    assert _report_statuses(transport) == ["booting", "ready", "ready", "ready", "torn_down"]
    assert clock.sleeps == [30.0, 30.0, 30.0]  # no 4th sleep -- stopped right at the boundary
    assert len(ops.teardown_calls) == 1


# ---------------------------------------------------------------------------
# (e) unexpected exception mid-supervise -> finally still tears down
# ---------------------------------------------------------------------------


def test_unexpected_exception_mid_supervise_still_tears_down(caplog):
    # A long TTL so the loop would never naturally reach the deadline within
    # a couple of ticks -- the ONLY way this test's clock stops is the
    # injected explosion, proving the finally (not a lucky TTL expiry) is
    # what triggers teardown.
    clock = ExplodingSleepClock(boom_on_call=2)
    ops = FakeBootOps()
    transport = FakeTransport([_claim_response(ttlSeconds=1000)])
    config = _config()

    with caplog.at_level(logging.WARNING, logger="agentrail.runner.preview_worker"):
        # run_preview_worker must NOT propagate the exception -- the outer
        # per-claim try/except is the process-level safety net (a bug here
        # must end only this claim's supervision, never the worker process).
        preview_worker.run_preview_worker(
            config, transport=transport, sleep=clock.sleep, now=clock.now,
            clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
            liveness_interval=30.0,
            should_continue=_stop_after(1),
        )

    # booting + the initial ready + one successful liveness tick were
    # reported before the 2nd sleep() call exploded; torn_down was never
    # reached because the crash interrupted the loop first.
    assert _report_statuses(transport) == ["booting", "ready", "ready"]
    assert clock.sleeps == [30.0]  # the 2nd (exploding) call never got to advance the clock
    # The finally still tore down the real boot handle despite the crash.
    assert len(ops.teardown_calls) == 1
    assert ops.teardown_calls[0].url == "http://127.0.0.1:3000"
    assert any("failed unexpectedly" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# bonus: clone failure -- same shape as (b)/(c), a gap the brief's flow
# implies (clone_pr_head "Raises RuntimeError ... on any failure") but
# doesn't spell out explicitly.
# ---------------------------------------------------------------------------


def test_clone_failure_reports_failed_and_cleans_dir_without_booting():
    clock = FakeClock()
    ops = FakeBootOps(clone_raises=RuntimeError("git clone failed: authentication failed"))
    transport = FakeTransport([_claim_response()])
    config = _config()

    preview_worker.run_preview_worker(
        config, transport=transport, sleep=clock.sleep, now=clock.now,
        clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
        should_continue=_stop_after(1),
    )

    assert _report_statuses(transport) == ["booting", "failed"]
    assert _report_bodies(transport)[1]["reason"] == "clone_failed"
    assert ops.detect_calls == []  # never reached
    assert ops.boot_calls == []
    assert ops.teardown_calls == []
    dest = ops.clone_calls[0]["dest"]
    assert not os.path.isdir(dest)


# ---------------------------------------------------------------------------
# claim-loop plumbing: idle polling + a transient transport error
# ---------------------------------------------------------------------------


def test_idle_claim_sleeps_and_retries_without_booting():
    clock = FakeClock()
    ops = FakeBootOps()
    transport = FakeTransport([_no_item_response(), _claim_response()])
    config = _config()

    preview_worker.run_preview_worker(
        config, transport=transport, sleep=clock.sleep, now=clock.now,
        clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
        idle_seconds=10.0, liveness_interval=30.0,
        should_continue=_stop_after(2),
    )

    statuses = _report_statuses(transport)
    assert statuses[0] == "booting"  # nothing reported for the 204 poll itself
    assert statuses[-1] == "torn_down"
    assert clock.sleeps[0] == 10.0  # the idle wait after the 204


def test_transport_error_on_claim_is_swallowed_and_retried(caplog):
    clock = FakeClock()
    ops = FakeBootOps()
    transport = FakeTransport([RuntimeError("connection reset"), _no_item_response()])
    config = _config()

    with caplog.at_level(logging.WARNING, logger="agentrail.runner.preview_worker"):
        preview_worker.run_preview_worker(
            config, transport=transport, sleep=clock.sleep, now=clock.now,
            clone=ops.clone, detect_recipe=ops.detect_recipe, boot=ops.boot, teardown=ops.teardown,
            idle_seconds=5.0,
            should_continue=_stop_after(2),
        )

    assert _report_statuses(transport) == []  # never got far enough to claim anything real
    assert clock.sleeps == [5.0, 5.0]
    assert any("claim failed" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# config / gating (main())
# ---------------------------------------------------------------------------


def test_main_noops_when_disabled(monkeypatch):
    monkeypatch.delenv(preview_worker.ENABLED_ENV, raising=False)
    called = {"ran": False}
    monkeypatch.setattr(preview_worker, "run_preview_worker", lambda *a, **k: called.__setitem__("ran", True))

    preview_worker.main([])

    assert called["ran"] is False


def test_main_noops_when_enabled_but_missing_base_url_or_token(monkeypatch):
    monkeypatch.setenv(preview_worker.ENABLED_ENV, "1")
    monkeypatch.delenv(preview_worker.BASE_URL_ENV, raising=False)
    monkeypatch.delenv(preview_worker.TOKEN_ENV, raising=False)
    called = {"ran": False}
    monkeypatch.setattr(preview_worker, "run_preview_worker", lambda *a, **k: called.__setitem__("ran", True))

    preview_worker.main([])

    assert called["ran"] is False


def test_main_starts_the_loop_when_enabled_and_configured(monkeypatch):
    monkeypatch.setenv(preview_worker.ENABLED_ENV, "1")
    monkeypatch.setenv(preview_worker.BASE_URL_ENV, "https://console.test")
    monkeypatch.setenv(preview_worker.TOKEN_ENV, "tok")
    monkeypatch.delenv(preview_worker.ADVERTISE_HOST_ENV, raising=False)
    captured: Dict[str, Any] = {}
    monkeypatch.setattr(
        preview_worker, "run_preview_worker",
        lambda config, **kw: captured.update(config=config, kwargs=kw),
    )

    preview_worker.main([])

    assert captured["config"].base_url == "https://console.test"
    assert captured["config"].token == "tok"
    assert captured["config"].advertise_host == preview_worker.DEFAULT_ADVERTISE_HOST
    assert captured["config"].worker_id  # non-empty, generated
