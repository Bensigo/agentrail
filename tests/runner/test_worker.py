"""Tests for the runner worker loop (agentrail/runner/worker.py).

The worker is the heart of the downloaded CLI: claim a dispatched issue, run it
locally, report the outcome, repeat. Execution and timing are injected so the
loop is hermetic — no real clone, agent, or sleep.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from agentrail.runner.client import WorkItem
from agentrail.runner.worker import run_worker
from agentrail.sandbox.docker_runner import RunResult


class FakeClient:
    """A RunnerClient stand-in: hands out scripted items, records reports."""

    def __init__(self, items: List[Optional[WorkItem]]) -> None:
        self._items = list(items)
        self.reported: List[Dict[str, Any]] = []

    def claim_next(self) -> Optional[WorkItem]:
        return self._items.pop(0) if self._items else None

    def report_result(self, item: WorkItem, **kw: Any) -> bool:
        self.reported.append({"id": item.id, **kw})
        return True


def _item(n: str) -> WorkItem:
    return WorkItem(
        id=f"wi-{n}", workspace_id="ws1", source="github", external_id=n,
        repo_url="https://github.com/o/r", ref="main", title="t", body="b",
    )


def _stop_after(n: int):
    calls = {"n": 0}

    def should_continue() -> bool:
        calls["n"] += 1
        return calls["n"] <= n

    return should_continue


def test_worker_claims_runs_and_reports_one_item():
    client = FakeClient([_item("42")])
    executed: List[str] = []

    def execute(item: WorkItem) -> RunResult:
        executed.append(item.external_id)
        return RunResult(status="green", cost_usd=0.5, branch="afk/github-42")

    run_worker(
        client,
        execute=execute,
        sleep=lambda _s: None,
        idle_seconds=1,
        should_continue=_stop_after(1),
    )

    assert executed == ["42"]
    assert client.reported == [
        {
            "id": "wi-42",
            "status": "green",
            "cost_usd": 0.5,
            "branch": "afk/github-42",
            "gate_reason": "",
            "logs_tail": "",
        }
    ]


def test_worker_sleeps_when_idle_and_does_not_execute():
    client = FakeClient([None])  # nothing to claim
    executed: List[str] = []
    sleeps: List[float] = []

    run_worker(
        client,
        execute=lambda item: executed.append(item.external_id),
        sleep=sleeps.append,
        idle_seconds=7,
        should_continue=_stop_after(1),
    )

    assert executed == []
    assert sleeps == [7]  # waited the idle interval rather than busy-looping


def test_worker_survives_an_execution_error_and_keeps_going():
    # First item blows up mid-execute; the loop must report an error and still
    # process the second item rather than crashing.
    client = FakeClient([_item("1"), _item("2")])

    def execute(item: WorkItem) -> RunResult:
        if item.external_id == "1":
            raise RuntimeError("agent exploded")
        return RunResult(status="green")

    run_worker(
        client,
        execute=execute,
        sleep=lambda _s: None,
        idle_seconds=1,
        should_continue=_stop_after(2),
    )

    statuses = {r["id"]: r["status"] for r in client.reported}
    assert statuses["wi-1"] == "error"  # crash reported, not swallowed
    assert statuses["wi-2"] == "green"  # loop kept going
