"""Tests for the fleet's multi-workspace claim→execute→report loop
(agentrail/runner/fleet_worker.py).

Mirrors agentrail/tests/runner/test_worker.py's hermetic style (injected
sleep/should_continue, fake clients — no real network, no real subprocess,
no real time.sleep), extended for the one genuinely new mechanic: rotating
across MULTIPLE workspaces instead of claiming against a single one.
"""
from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

from agentrail.runner.client import RunnerAuthError, RunnerError, WorkItem
from agentrail.runner.fleet_worker import (
    WorkspaceRotation,
    WorkspaceSlot,
    run_fleet_worker,
)
from agentrail.sandbox.docker_runner import RunResult


class FakeClient:
    """A per-workspace RunnerClient stand-in: hands out scripted items, records
    reports/telemetry. Cycles: once its scripted items are exhausted, every
    further claim_next() call returns None (mirrors "nothing queued")."""

    def __init__(self, workspace_id: str, items: Optional[List[Optional[WorkItem]]] = None) -> None:
        self.workspace_id = workspace_id
        self._items = list(items or [])
        self.claim_calls = 0
        self.reported: List[Dict[str, Any]] = []
        self.telemetry: List[Dict[str, Any]] = []

    def claim_next(self) -> Optional[WorkItem]:
        self.claim_calls += 1
        return self._items.pop(0) if self._items else None

    def report_result(self, item: WorkItem, **kw: Any) -> bool:
        self.reported.append({"id": item.id, **kw})
        return True

    def report_telemetry(self, item: WorkItem, *, status: str,
                         gate_reason: str = "", evidence: str = "", **kw: Any) -> None:
        self.telemetry.append({"id": item.id, "status": status})


class AuthFailClient(FakeClient):
    """A client whose claim_next always raises RunnerAuthError."""

    def claim_next(self):
        self.claim_calls += 1
        raise RunnerAuthError(f"token rejected for {self.workspace_id}")


def _item(workspace_id: str, n: str) -> WorkItem:
    return WorkItem(
        id=f"{workspace_id}-{n}", workspace_id=workspace_id, source="github",
        external_id=n, repo_url="https://github.com/o/r", ref="main", title="t", body="b",
    )


def _slot(workspace_id: str, client, execute=None) -> WorkspaceSlot:
    if execute is None:
        def execute(item: WorkItem) -> RunResult:
            return RunResult(status="green")
    return WorkspaceSlot(workspace_id=workspace_id, client=client, execute=execute)


def _stop_after(n: int):
    calls = {"n": 0}

    def should_continue() -> bool:
        calls["n"] += 1
        return calls["n"] <= n

    return should_continue


# --- Rotation visits every workspace -----------------------------------------


def test_rotation_next_cycles_round_robin_in_order():
    rotation = WorkspaceRotation(
        [_slot("ws1", FakeClient("ws1")), _slot("ws2", FakeClient("ws2")), _slot("ws3", FakeClient("ws3"))]
    )
    order = [rotation.next().workspace_id for _ in range(7)]
    assert order == ["ws1", "ws2", "ws3", "ws1", "ws2", "ws3", "ws1"]


def test_rotation_next_returns_none_when_empty():
    assert WorkspaceRotation([]).next() is None


def test_loop_visits_every_workspace_at_least_once(monkeypatch):
    clients = {ws: FakeClient(ws) for ws in ("ws1", "ws2", "ws3")}
    rotation = WorkspaceRotation([_slot(ws, c) for ws, c in clients.items()])

    run_fleet_worker(
        rotation,
        sleep=lambda _s: None,
        idle_seconds=1,
        should_continue=_stop_after(6),  # two full rounds of 3 workspaces
        concurrency=1,
    )

    for ws, client in clients.items():
        assert client.claim_calls >= 1, f"{ws} was never visited"


def test_loop_executes_claimed_items_and_reports_them(monkeypatch):
    client = FakeClient("ws1", items=[_item("ws1", "42")])
    executed: List[str] = []

    def execute(item: WorkItem) -> RunResult:
        executed.append(item.id)
        return RunResult(status="green", cost_usd=0.5, branch="agentrail/issue-42")

    rotation = WorkspaceRotation([_slot("ws1", client, execute=execute)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1, should_continue=_stop_after(2),
        concurrency=1,
    )

    assert executed == ["ws1-42"]
    assert client.reported == [
        {"id": "ws1-42", "status": "green", "cost_usd": 0.5, "branch": "agentrail/issue-42",
         "gate_reason": "", "logs_tail": "", "pr_url": "",
         # #1338 PR① fix round: the fleet reuses worker._report byte-for-byte,
         # so it forwards execute_model too ("" — this result carries none).
         "execute_model": ""}
    ]
    assert client.telemetry == [{"id": "ws1-42", "status": "green"}]


# --- Per-workspace auth failure isolates -------------------------------------


def test_one_workspace_auth_failure_drops_only_that_workspace_others_keep_claiming():
    good_a = FakeClient("ws-good-a", items=[_item("ws-good-a", "1")])
    bad = AuthFailClient("ws-bad")
    good_b = FakeClient("ws-good-b", items=[_item("ws-good-b", "2")])
    rotation = WorkspaceRotation([_slot("ws-good-a", good_a), _slot("ws-bad", bad), _slot("ws-good-b", good_b)])

    dropped: List[str] = []
    run_fleet_worker(
        rotation,
        sleep=lambda _s: None,
        idle_seconds=1,
        # enough turns for: good_a, bad(drops), good_b, good_a(again), ...
        should_continue=_stop_after(8),
        concurrency=1,
        on_auth_drop=lambda ws_id, exc: dropped.append(ws_id),
    )

    assert dropped == ["ws-bad"]
    assert "ws-bad" not in rotation.workspace_ids()
    assert set(rotation.workspace_ids()) == {"ws-good-a", "ws-good-b"}
    # both good workspaces got their item executed/reported despite ws-bad's failure.
    assert [r["id"] for r in good_a.reported] == ["ws-good-a-1"]
    assert [r["id"] for r in good_b.reported] == ["ws-good-b-2"]
    # the bad client was only ever asked to claim once (dropped immediately after).
    assert bad.claim_calls == 1


def test_all_workspaces_failing_leaves_rotation_empty_but_loop_survives():
    bad1 = AuthFailClient("ws1")
    bad2 = AuthFailClient("ws2")
    rotation = WorkspaceRotation([_slot("ws1", bad1), _slot("ws2", bad2)])
    dropped: List[str] = []
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(5), concurrency=1,
        on_auth_drop=lambda ws_id, exc: dropped.append(ws_id),
    )
    assert sorted(dropped) == ["ws1", "ws2"]
    assert rotation.is_empty()


def test_default_auth_drop_message_gives_fleet_guidance_not_login_advice(capsys):
    # RunnerAuthError's own message says "run `agentrail login` again" — right
    # for the single-workspace CLI, wrong for a fleet workspace (no human ever
    # logs one in). The default drop handler must give the fleet-correct
    # recovery (revoke in console -> next sync re-mints) and never surface the
    # login advice.
    from agentrail.runner.fleet_worker import _default_on_auth_drop

    _default_on_auth_drop("ws-9", RunnerAuthError(
        "runner token was rejected — run `agentrail login` again"
    ))
    err = capsys.readouterr().err
    assert "agentrail login" not in err
    assert "ws-9" in err
    assert "revoke" in err.lower()
    assert "next sync" in err.lower()


def test_transient_claim_error_does_not_drop_the_workspace():
    class FlakyClient(FakeClient):
        def claim_next(self):
            self.claim_calls += 1
            if self.claim_calls == 1:
                raise RunnerError("503 service unavailable")
            return super().claim_next()

    client = FlakyClient("ws1", items=[_item("ws1", "9")])
    rotation = WorkspaceRotation([_slot("ws1", client)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(3), concurrency=1,
    )
    assert "ws1" in rotation.workspace_ids()  # a non-auth error must not drop it
    assert [r["id"] for r in client.reported] == ["ws1-9"]


# --- Concurrency bounded ------------------------------------------------------


def test_concurrency_is_bounded_and_workspaces_execute_in_parallel():
    lock = threading.Lock()
    max_in_flight = {"now": 0, "peak": 0}
    reported: List[str] = []

    def make_execute():
        def execute(item: WorkItem) -> RunResult:
            with lock:
                max_in_flight["now"] += 1
                max_in_flight["peak"] = max(max_in_flight["peak"], max_in_flight["now"])
            import time as _t
            _t.sleep(0.02)
            with lock:
                max_in_flight["now"] -= 1
            return RunResult(status="green")
        return execute

    # 6 workspaces, one item each — with concurrency=3 at most 3 should overlap.
    clients = {f"ws{n}": FakeClient(f"ws{n}", items=[_item(f"ws{n}", "1")]) for n in range(6)}
    slots = [_slot(ws, c, execute=make_execute()) for ws, c in clients.items()]
    rotation = WorkspaceRotation(slots)

    def should_continue() -> bool:
        with lock:
            return len(reported) < 6

    orig_report_results = []
    for c in clients.values():
        orig = c.report_result

        def _wrap(item, orig=orig, **kw):
            with lock:
                reported.append(item.id)
            return orig(item, **kw)

        c.report_result = _wrap  # type: ignore[method-assign]

    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=0.01,
        should_continue=should_continue, concurrency=3,
    )

    assert sorted(reported) == sorted(f"ws{n}-1" for n in range(6))
    assert len(set(reported)) == 6  # no item processed twice
    assert max_in_flight["peak"] <= 3  # never exceeded the concurrency bound
    assert max_in_flight["peak"] >= 2  # genuinely overlapped, not accidentally serial


# --- Execution error handling (mirrors worker.py's own guarantee) -----------


def test_execution_error_is_reported_as_error_and_loop_continues():
    client = FakeClient("ws1", items=[_item("ws1", "1"), _item("ws1", "2")])

    def execute(item: WorkItem) -> RunResult:
        if item.id.endswith("-1"):
            raise RuntimeError("agent exploded")
        return RunResult(status="green")

    rotation = WorkspaceRotation([_slot("ws1", client, execute=execute)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(3), concurrency=1,
    )
    statuses = {r["id"]: r["status"] for r in client.reported}
    assert statuses["ws1-1"] == "error"
    assert statuses["ws1-2"] == "green"


# --- Per-pass idle semantics (#1267 PR② review fix) --------------------------
# The idle sleep fires once per FULLY-EMPTY rotation pass, never per empty
# claim — otherwise per-workspace poll latency would scale with fleet size
# (ceil(workspaces/concurrency) * idle_seconds).


def test_idle_sleeps_once_per_full_empty_pass_not_per_empty_claim():
    clients = {ws: FakeClient(ws) for ws in ("ws1", "ws2", "ws3")}  # always empty
    rotation = WorkspaceRotation([_slot(ws, c) for ws, c in clients.items()])
    sleeps: List[float] = []
    # 8 loop turns at concurrency=1: sweep of 3 empties -> 1 sleep turn ->
    # sweep of 3 empties -> 1 sleep turn. Per-empty-claim sleeping would have
    # produced 6+ sleeps here; per-pass produces exactly 2.
    run_fleet_worker(
        rotation, sleep=sleeps.append, idle_seconds=7,
        should_continue=_stop_after(8), concurrency=1,
    )
    assert sleeps == [7, 7]
    # Both sweeps really did visit every workspace back-to-back (no sleeps
    # between individual empty claims).
    assert [c.claim_calls for c in clients.values()] == [2, 2, 2]


def test_a_claim_anywhere_in_the_pass_resets_the_idle_streak():
    # ws2 has one item; the pass containing that claim must NOT sleep — only
    # once a full pass of consecutive empties completes does one sleep fire.
    clients = {
        "ws1": FakeClient("ws1"),
        "ws2": FakeClient("ws2", items=[_item("ws2", "1")]),
        "ws3": FakeClient("ws3"),
    }
    rotation = WorkspaceRotation([_slot(ws, c) for ws, c in clients.items()])
    sleeps: List[float] = []
    # Turns: ws1 empty(streak 1), ws2 CLAIM(reset), ws3 empty(1), ws1 empty(2),
    # ws2 empty(3 -> full empty pass, gen bump), sleep turn. 6 turns, 1 sleep.
    run_fleet_worker(
        rotation, sleep=sleeps.append, idle_seconds=5,
        should_continue=_stop_after(6), concurrency=1,
    )
    assert sleeps == [5]
    assert [r["id"] for r in clients["ws2"].reported] == ["ws2-1"]


def test_transient_claim_errors_count_toward_the_empty_pass():
    # A console outage (every claim raising) must reach a fully-empty pass and
    # idle between sweeps — not spin through error turns forever.
    class AlwaysErrorClient(FakeClient):
        def claim_next(self):
            self.claim_calls += 1
            raise RunnerError("503 service unavailable")

    clients = {ws: AlwaysErrorClient(ws) for ws in ("ws1", "ws2")}
    rotation = WorkspaceRotation([_slot(ws, c) for ws, c in clients.items()])
    sleeps: List[float] = []
    # Turns: ws1 error(1), ws2 error(2 -> gen bump), sleep turn.
    run_fleet_worker(
        rotation, sleep=sleeps.append, idle_seconds=9,
        should_continue=_stop_after(3), concurrency=1,
    )
    assert sleeps == [9]
    assert "ws1" in rotation.workspace_ids()  # transient errors never drop


def test_empty_rotation_still_idles_without_pass_accounting():
    rotation = WorkspaceRotation([])
    sleeps: List[float] = []
    run_fleet_worker(
        rotation, sleep=sleeps.append, idle_seconds=7,
        should_continue=_stop_after(2), concurrency=1,
    )
    assert sleeps == [7, 7]  # nothing to sweep at all -> plain idle each turn


def test_rotation_pass_accounting_unit():
    rotation = WorkspaceRotation(
        [_slot("ws1", FakeClient("ws1")), _slot("ws2", FakeClient("ws2"))]
    )
    assert rotation.idle_generation() == 0
    rotation.note_empty()
    assert rotation.idle_generation() == 0  # 1 of 2 — pass not complete
    rotation.note_empty()
    assert rotation.idle_generation() == 1  # full empty pass
    rotation.note_empty()
    rotation.note_claim()  # claim resets the streak mid-pass
    rotation.note_empty()
    assert rotation.idle_generation() == 1  # streak never re-reached 2
    rotation.note_empty()
    assert rotation.idle_generation() == 2


def test_rotation_drop_and_refresh_reset_the_streak():
    rotation = WorkspaceRotation(
        [_slot("ws1", FakeClient("ws1")), _slot("ws2", FakeClient("ws2"))]
    )
    rotation.note_empty()  # streak 1 of 2
    rotation.drop("ws1")   # membership changed -> streak reset (size now 1)
    rotation.note_empty()
    assert rotation.idle_generation() == 1  # needed a FULL fresh pass of the new size
    rotation.refresh([_slot("ws3", FakeClient("ws3")), _slot("ws4", FakeClient("ws4"))])
    rotation.note_empty()
    assert rotation.idle_generation() == 1  # refresh reset the streak too


# --- Blocked-claim visibility (#1267 PR④ item 0, reviewer-carried from PR②) --
#
# client.last_claim_blocked (set by RunnerClient.claim_next on a 204 that
# carries the workspace-budget header, #1269 PR2a) was read by worker.py's
# single-workspace loop (#1324) but never by this rotation at all -- a
# budget-capped fleet workspace idled in rotation with NO operator-visible
# signal, indistinguishable from "nothing queued anywhere." These tests pin
# the fix: exactly one log line per workspace per idle->blocked transition,
# tracked independently per workspace so one workspace's budget cap never
# affects another's logging.


def test_rotation_note_claim_blocked_transitions_are_tracked_per_workspace():
    rotation = WorkspaceRotation(
        [_slot("ws-a", FakeClient("ws-a")), _slot("ws-b", FakeClient("ws-b"))]
    )
    assert rotation.note_claim_blocked("ws-a") is True  # first block -> transition
    assert rotation.note_claim_blocked("ws-a") is False  # still blocked -> quiet
    assert rotation.note_claim_blocked("ws-a") is False  # still blocked -> quiet
    # ws-b's own blocked tracking is completely independent of ws-a's state.
    assert rotation.note_claim_blocked("ws-b") is True
    rotation.note_claim_unblocked("ws-a")  # an unblocked poll re-arms ws-a
    assert rotation.note_claim_blocked("ws-a") is True  # transition again
    assert rotation.note_claim_blocked("ws-b") is False  # ws-b untouched throughout


def test_rotation_note_claim_unblocked_is_a_no_op_when_never_blocked():
    rotation = WorkspaceRotation([_slot("ws1", FakeClient("ws1"))])
    rotation.note_claim_unblocked("ws1")  # must not raise
    assert rotation.note_claim_blocked("ws1") is True  # still a fresh transition


class BlockableFakeClient(FakeClient):
    """Always returns None from claim_next (as a real blocked OR idle poll
    does) and scripts last_claim_blocked per call -- mirrors
    agentrail/tests/runner/test_worker.py's own fake for the single-workspace
    loop, adapted to carry a workspace_id."""

    def __init__(self, workspace_id: str, blocked_sequence: List[Optional[str]]) -> None:
        super().__init__(workspace_id)
        self._script = list(blocked_sequence)
        self.last_claim_blocked: Optional[str] = None

    def claim_next(self) -> Optional[WorkItem]:
        self.claim_calls += 1
        self.last_claim_blocked = self._script.pop(0) if self._script else None
        return None


class AlwaysClaimableClient(FakeClient):
    """A workspace that always has fresh work to claim.

    Used as the OTHER slot alongside a BlockableFakeClient so that
    workspace's idle streak never accumulates (every claim resets it via
    note_claim()) -- keeping the round-robin turn order perfectly
    predictable (no interleaved idle-pass sleep turns) so the exact
    blocked/blocked/idle/blocked sequence lands on the turns this test
    expects.
    """

    def claim_next(self) -> Optional[WorkItem]:
        self.claim_calls += 1
        return _item(self.workspace_id, str(self.claim_calls))


def test_fleet_logs_blocked_claim_once_per_transition_and_other_workspaces_unaffected(caplog):
    import logging

    # blocked, blocked, idle, blocked -> exactly two logs for ws-blocked: the
    # first blocked poll (idle->blocked), and the fourth (idle->blocked again,
    # after the third poll's unblocked tick re-armed it). The second poll
    # (still blocked) and third (idle) stay silent -- byte-identical
    # transition semantics to test_worker.py's own single-workspace pin.
    blocked = BlockableFakeClient(
        "ws-blocked", ["workspace-budget", "workspace-budget", None, "workspace-budget"]
    )
    other = AlwaysClaimableClient("ws-other")
    rotation = WorkspaceRotation([_slot("ws-blocked", blocked), _slot("ws-other", other)])

    with caplog.at_level(logging.WARNING, logger="agentrail.runner.fleet_worker"):
        run_fleet_worker(
            rotation, sleep=lambda _s: None, idle_seconds=0,
            should_continue=_stop_after(8), concurrency=1,
        )

    assert blocked.claim_calls == 4
    blocked_logs = [
        r for r in caplog.records if "ws-blocked: claims paused" in r.message
    ]
    assert len(blocked_logs) == 2
    assert "workspace-budget" in blocked_logs[0].message

    # The other workspace claimed and reported every turn without any
    # blocked-related interference or extra log noise about IT.
    assert other.claim_calls == 4
    assert len(other.reported) == 4
    assert not [r for r in caplog.records if "ws-other" in r.message]


def test_fleet_never_logs_blocked_when_header_absent():
    """Regression-pin: a plain client (no last_claim_blocked ever truthy) must
    produce zero blocked-claim logs -- today's behavior, byte-identical."""
    import logging

    client = FakeClient("ws1")  # always returns None, no last_claim_blocked attr at all
    rotation = WorkspaceRotation([_slot("ws1", client)])
    with_caplog = []

    class _Handler(logging.Handler):
        def emit(self, record):
            with_caplog.append(record)

    logger = logging.getLogger("agentrail.runner.fleet_worker")
    handler = _Handler()
    logger.addHandler(handler)
    try:
        run_fleet_worker(
            rotation, sleep=lambda _s: None, idle_seconds=0,
            should_continue=_stop_after(3), concurrency=1,
        )
    finally:
        logger.removeHandler(handler)

    assert not hasattr(client, "last_claim_blocked")
    assert not [r for r in with_caplog if "claims paused" in r.getMessage()]


# --- Single-active-fleet lease gate (#1390) ----------------------------------
# The `is_active` gate is checked at the TOP of every sweep. A standby instance
# (lease held by another) must claim NOTHING; an active/holder instance claims
# exactly as before. Default is `lambda: True`, so every test above (which omits
# it) exercises the unchanged single-instance path.


def test_standby_instance_claims_nothing():
    client = FakeClient("ws1", items=[_item("ws1", "1")])
    rotation = WorkspaceRotation([_slot("ws1", client)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(6), concurrency=1,
        is_active=lambda: False,  # this instance is a lease standby
    )
    assert client.claim_calls == 0  # never claimed while standing by


def test_active_instance_claims_as_normal():
    client = FakeClient("ws1", items=[_item("ws1", "1")])
    rotation = WorkspaceRotation([_slot("ws1", client)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(3), concurrency=1,
        is_active=lambda: True,  # this instance holds the lease
    )
    assert client.claim_calls >= 1


def test_slot_starts_claiming_the_moment_it_is_promoted_mid_run():
    # Standby for the first two turns, then promoted (lease acquired) -> claims.
    checks = {"n": 0}

    def is_active() -> bool:
        checks["n"] += 1
        return checks["n"] > 2

    client = FakeClient("ws1", items=[_item("ws1", "1")])
    rotation = WorkspaceRotation([_slot("ws1", client)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(6), concurrency=1,
        is_active=is_active,
    )
    assert client.claim_calls >= 1  # resumed claiming after promotion


def test_default_is_active_is_true_single_instance_path_unchanged():
    # No is_active passed -> default lambda: True -> byte-identical to before
    # the lease hook existed (the sole-instance / no-DATABASE_URL path).
    client = FakeClient("ws1", items=[_item("ws1", "1")])
    rotation = WorkspaceRotation([_slot("ws1", client)])
    run_fleet_worker(
        rotation, sleep=lambda _s: None, idle_seconds=1,
        should_continue=_stop_after(3), concurrency=1,
    )
    assert client.claim_calls >= 1
