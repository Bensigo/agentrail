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
         "gate_reason": "", "logs_tail": "", "pr_url": ""}
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


def test_idle_sleeps_when_nothing_queued_anywhere():
    clients = {ws: FakeClient(ws) for ws in ("ws1", "ws2")}  # no items -> always None
    rotation = WorkspaceRotation([_slot(ws, c) for ws, c in clients.items()])
    sleeps: List[float] = []
    run_fleet_worker(
        rotation, sleep=sleeps.append, idle_seconds=7,
        should_continue=_stop_after(2), concurrency=1,
    )
    assert sleeps == [7, 7]
