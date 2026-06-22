"""Acceptance test for GitHub issue #870.

WHY THIS IS RED NOW
-------------------
``run_issue_on_host`` (the host-native runner path) completes a run, parses
``run.json``, and returns a ``RunResult`` — but never makes any HTTP push for
``review_gate``, ``failure_event``, ``memory_items``, or ``outbox_flush``.
Telemetry Health therefore permanently shows these four signals as Missing
(red) for every runner-driven run, even when the underlying steps occurred.

WHAT THE IMPLEMENTER MUST DO TO MAKE THIS GREEN
------------------------------------------------
After ``run_issue_on_host`` obtains the verdict from ``run.json``:

  1. Push a ``review_gate`` event to the run-events ingest endpoint whenever a
     verdict was obtained (green or red), e.g. via
     POST /api/v1/ingest/run-events  with  event_type = "review_gate_passed"
     (or "review_gate_failed") so the ClickHouse query
       ``event_type LIKE 'review_gate%'``
     matches it.

  2. Push a ``failure_event`` to /api/v1/ingest/failure-events when the
     verdict is red or error.

  3. Push ``outbox_flush`` / ``memory_items`` events when the corresponding
     run artefacts are present in the run directory.

  4. On a Green run with no failure, ``failure_event`` absent MUST NOT count
     as a red "Missing" health signal.  Either emit a definitive
     "no failures" ``failure_event`` marker with a sentinel payload, or
     update ``check_run_telemetry`` to distinguish not-applicable from
     never-wired.  Document the chosen rule.

The push must use the ``AGENTRAIL_SERVER_*`` link already present in ``env``
(the dict forwarded by ``_make_execute``), following the same
urllib + Bearer pattern as the existing push modules in ``agentrail/run/``.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List
from unittest.mock import patch

import pytest

from agentrail.sandbox.native_runner import run_issue_on_host


# ---------------------------------------------------------------------------
# Minimal fakes (mirrors test_native_runner; not shared via conftest yet)
# ---------------------------------------------------------------------------

class _Completed:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _FakeRunner:
    """Replays scripted results in order; entries may be callables."""

    def __init__(self, results: list) -> None:
        self._results = list(results)
        self.calls: List[dict] = []

    def run(self, cmd, *, cwd=None, env=None, timeout=None, **_):
        self.calls.append({"cmd": list(cmd), "cwd": cwd, "env": dict(env or {})})
        if not self._results:
            raise AssertionError(f"unexpected extra call: {cmd!r}")
        nxt = self._results.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        if callable(nxt):
            return nxt(cmd, cwd, env)
        return nxt


class _RunDirs:
    """Injectable run_dir_factory that hands out real temp dirs."""

    def __init__(self, base: Path) -> None:
        self._base = base
        self._n = 0
        self.created: List[Path] = []

    def __call__(self) -> Path:
        self._n += 1
        d = self._base / f"run-{self._n}"
        d.mkdir(parents=True, exist_ok=True)
        self.created.append(d)
        return d


class _FakeHttpResponse:
    """urllib-compatible context-manager response stub (HTTP 202)."""

    status = 202

    def read(self) -> bytes:
        return b""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


def _write_run_json(run_dir: Path, payload: dict) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "run.json").write_text(json.dumps(payload))


# ---------------------------------------------------------------------------
# Acceptance test — issue #870
# ---------------------------------------------------------------------------

class TestRunnerTelemetryEmission:
    """AC #870: the runner path must emit review_gate telemetry after a run."""

    def test_green_run_emits_review_gate_telemetry_to_server(
        self, tmp_path, monkeypatch
    ) -> None:
        """A runner run that reaches the review gate (green verdict) MUST push
        a ``review_gate`` event to the telemetry ingest endpoint.

        The AGENTRAIL_SERVER_* env vars are set — exactly as ``_make_execute``
        in ``runner.py`` does for real runner invocations.  The subprocess is
        faked so only the *parent* runner process's HTTP calls are observed.
        After the run, at least one HTTP POST to the server URL must carry a
        review_gate indicator (event_type or URL path).

        CURRENTLY FAILS: ``run_issue_on_host`` exits after parsing ``run.json``
        and makes zero telemetry HTTP calls for the four missing signals.
        """
        # ---- server link (mirrors what _make_execute sets in runner.py) ----
        server_url = "https://agentrail.test"
        api_key = "test-bearer-token-870"
        repository_id = "repo-issue-870"

        # load_link() reads from os.environ when no server.json is present.
        monkeypatch.setenv("AGENTRAIL_SERVER_BASE_URL", server_url)
        monkeypatch.setenv("AGENTRAIL_SERVER_API_KEY", api_key)
        monkeypatch.setenv("AGENTRAIL_SERVER_REPOSITORY_ID", repository_id)

        # ---- fake subprocess: clone ok, run writes green run.json ----------
        run_dir_root = tmp_path / "run-1"

        def _fake_agentrail_run(cmd, cwd, env):
            log_dir = (
                cmd[cmd.index("--log-dir") + 1]
                if "--log-dir" in cmd
                else str(run_dir_root)
            )
            run_id = (
                cmd[cmd.index("--run-id") + 1]
                if "--run-id" in cmd
                else "host-run"
            )
            _write_run_json(
                Path(log_dir) / run_id,
                {"objectiveGate": {"verdict": "green"}},
            )
            return _Completed(0, stdout="ok")

        dirs = _RunDirs(tmp_path)
        fake_runner = _FakeRunner([
            _Completed(0, stdout="cloned"),   # git clone
            _fake_agentrail_run,              # agentrail run issue
        ])

        # ---- intercept all urllib HTTP calls --------------------------------
        captured_http: List[dict] = []

        def _fake_urlopen(req, timeout=None):
            body_bytes = req.data or b""
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                body = body_bytes.decode("utf-8", "replace")
            captured_http.append({
                "url": req.full_url,
                "method": req.method,
                "body": body,
                "auth": req.get_header("Authorization"),
            })
            return _FakeHttpResponse()

        # ---- run ------------------------------------------------------------
        with patch("urllib.request.urlopen", _fake_urlopen):
            result = run_issue_on_host(
                repo_url="https://github.com/acme/widgets.git",
                ref="main",
                issue_ref="870",
                workspace_id="ws-870",
                env={
                    "AGENTRAIL_SERVER_BASE_URL": server_url,
                    "AGENTRAIL_SERVER_API_KEY": api_key,
                    "AGENTRAIL_SERVER_REPOSITORY_ID": repository_id,
                },
                run_dir_factory=dirs,
                runner=fake_runner,
                publish_pr=False,   # keep test focused; PR publish is separate
            )

        # ---- gate: the subprocess result was parsed correctly ---------------
        assert result.status == "green", (
            f"precondition failed — run should be green, got {result.status!r}"
        )

        # ---- primary AC: a review_gate event was pushed ---------------------
        urls_called = [c["url"] for c in captured_http]

        def _is_review_gate_call(call: dict) -> bool:
            """True when the HTTP call carries a review_gate signal."""
            url: str = call["url"].lower()
            # Option A: dedicated endpoint path contains "review"
            if "review" in url:
                return True
            # Option B: run-events payload has event_type like 'review_gate*'
            body = call.get("body")
            if isinstance(body, dict):
                event_type = str(body.get("event_type") or "").lower()
                submission_kind = str(body.get("submission_kind") or "").lower()
                if "review_gate" in event_type or submission_kind == "review_gate":
                    return True
            if isinstance(body, list):
                for item in body:
                    if not isinstance(item, dict):
                        continue
                    event_type = str(item.get("event_type") or "").lower()
                    action = item.get("action") or {}
                    action_type = str(
                        action.get("type") if isinstance(action, dict) else ""
                    ).lower()
                    if "review_gate" in event_type or "review_gate" in action_type:
                        return True
            return False

        review_gate_calls = [c for c in captured_http if _is_review_gate_call(c)]

        assert review_gate_calls, (
            "review_gate telemetry was NOT emitted by run_issue_on_host "
            "after a green run.\n"
            f"All HTTP calls made to {server_url!r}: {urls_called or '(none)'}\n\n"
            "Telemetry Health will show review_gate as Missing (red) for every "
            "runner-driven run.\n\n"
            "The implementer must add a push in the runner path "
            "(agentrail/sandbox/native_runner.py or a new push module it calls) "
            "that POSTs a review_gate event to the ingest endpoint after "
            "run_issue_on_host parses run.json."
        )
