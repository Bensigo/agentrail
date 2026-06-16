"""Tests for the runner worker loop (agentrail/runner/worker.py).

The worker is the heart of the downloaded CLI: claim a dispatched issue, run it
locally, report the outcome, repeat. Execution and timing are injected so the
loop is hermetic — no real clone, agent, or sleep.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from agentrail.runner.client import RunnerAuthError, RunnerError, WorkItem
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


def test_worker_stops_cleanly_on_auth_error():
    # A rejected token must stop the loop with a message, not crash with a
    # traceback (and certainly not try to execute anything).
    class AuthFailClient:
        def claim_next(self):
            raise RunnerAuthError("re-login")

        def report_result(self, *a, **k):  # pragma: no cover - never called
            raise AssertionError("should not report on auth failure")

    executed = []
    # should_continue is always True; the auth error must break the loop itself.
    run_worker(
        AuthFailClient(),
        execute=lambda item: executed.append(item),
        sleep=lambda _s: None,
        should_continue=lambda: True,
    )
    assert executed == []  # returned without crashing


def test_worker_runs_multiple_items_concurrently():
    # With concurrency=3, three slots drain a shared queue so 6 items finish in
    # ~2 waves instead of 6 serial ones — and the atomic claim means no item is
    # processed twice.
    import threading

    lock = threading.Lock()
    pending = [_item(str(n)) for n in range(6)]
    reported: List[str] = []
    max_in_flight = {"now": 0, "peak": 0}

    class ConcurrentClient:
        def claim_next(self):
            with lock:
                return pending.pop(0) if pending else None

        def report_result(self, item, **kw):
            with lock:
                reported.append(item.id)
                max_in_flight["now"] -= 1
            return True

    def execute(item: WorkItem) -> RunResult:
        with lock:
            max_in_flight["now"] += 1
            max_in_flight["peak"] = max(max_in_flight["peak"], max_in_flight["now"])
        # Hold the slot briefly so overlap is observable.
        import time as _t

        _t.sleep(0.02)
        return RunResult(status="green")

    # Stop once all 6 are reported.
    def should_continue() -> bool:
        with lock:
            return len(reported) < 6

    run_worker(
        ConcurrentClient(),
        execute=execute,
        sleep=lambda _s: None,
        concurrency=3,
        should_continue=should_continue,
    )

    assert sorted(reported) == [f"wi-{n}" for n in range(6)]  # all done, no dupes
    assert len(set(reported)) == 6
    assert max_in_flight["peak"] >= 2  # genuinely overlapped


def test_worker_survives_a_transient_claim_error_and_keeps_polling():
    # A non-auth claim error (server hiccup) should not kill the daemon: it
    # sleeps and tries again, eventually picking up the item.
    class FlakyClient:
        def __init__(self):
            self.calls = 0
            self.reported = []

        def claim_next(self):
            self.calls += 1
            if self.calls == 1:
                raise RunnerError("503 service unavailable")
            if self.calls == 2:
                return _item("9")
            return None

        def report_result(self, item, **kw):
            self.reported.append(item.id)
            return True

    client = FlakyClient()
    run_worker(
        client,
        execute=lambda item: RunResult(status="green"),
        sleep=lambda _s: None,
        should_continue=_stop_after(3),
    )
    assert client.reported == ["wi-9"]  # recovered and processed the item
