"""Tests for the fleet worker's execution-liveness ping (#1388).

The fleet worker reports liveness (~every 60s) WHILE a claim executes, so a
silently-dead runner is reclaimed within the liveness-staleness window instead
of the wall-clock fallback. These tests exercise the two guarantees that matter:
the pinger keeps pinging until execution ends, and a failing ping NEVER touches
the run's result (best-effort by construction — #1388 AC3).

Hermetic: no real network, no real time.sleep. The loop's wait uses
``threading.Event.wait(interval)``; passing ``interval=0`` makes it return
immediately so a stop set by the fake client deterministically ends the loop
after N pings without any wall-clock time passing.
"""
from __future__ import annotations

import threading
from typing import Any, List, Optional

from agentrail.runner.client import WorkItem
from agentrail.runner.fleet_worker import (
    WorkspaceSlot,
    _execute_with_liveness,
    _liveness_loop,
)
from agentrail.sandbox.docker_runner import RunResult


def _item() -> WorkItem:
    return WorkItem(
        id="wi-1",
        workspace_id="ws1",
        source="github",
        external_id="42",
        repo_url="https://github.com/o/r",
        ref="main",
        title="t",
        body="b",
    )


class _PingClient:
    """Records report_liveness calls; stops the loop after ``stop_after`` pings."""

    def __init__(self, stop: threading.Event, *, stop_after: int, raises: bool = False) -> None:
        self._stop = stop
        self._stop_after = stop_after
        self._raises = raises
        self.pings: List[WorkItem] = []

    def report_liveness(self, item: WorkItem) -> bool:
        self.pings.append(item)
        if len(self.pings) >= self._stop_after:
            self._stop.set()
        if self._raises:
            raise RuntimeError("console down")
        return True


def test_liveness_loop_pings_until_stopped():
    stop = threading.Event()
    client = _PingClient(stop, stop_after=3)
    _liveness_loop(client, _item(), interval=0.0, stop=stop)
    assert len(client.pings) == 3
    assert all(p.id == "wi-1" for p in client.pings)


def test_liveness_loop_swallows_ping_errors_and_keeps_going():
    # A ping that raises every time must not propagate out of the loop, and the
    # loop must keep pinging (AC3) until the stop is set.
    stop = threading.Event()
    client = _PingClient(stop, stop_after=2, raises=True)
    _liveness_loop(client, _item(), interval=0.0, stop=stop)  # must NOT raise
    assert len(client.pings) == 2


def test_liveness_loop_exits_immediately_when_already_stopped_after_one_ping():
    # Even a run that finishes before the first interval elapses gets exactly one
    # liveness stamp (claim leaves last_liveness_at NULL, so an early stamp matters).
    stop = threading.Event()
    stop.set()
    client = _PingClient(stop, stop_after=99)
    _liveness_loop(client, _item(), interval=0.0, stop=stop)
    assert len(client.pings) == 1


class _AlwaysFailPingClient:
    def report_liveness(self, item: WorkItem) -> bool:
        raise RuntimeError("console unreachable")


def _slot(client: Any, execute) -> WorkspaceSlot:
    return WorkspaceSlot(workspace_id="ws1", client=client, execute=execute)


def test_execute_with_liveness_returns_the_execute_result():
    executed: List[WorkItem] = []

    def execute(item: WorkItem) -> RunResult:
        executed.append(item)
        return RunResult(status="green")

    stop = threading.Event()
    client = _PingClient(stop, stop_after=1)
    result = _execute_with_liveness(_slot(client, execute), _item(), interval=0.0)
    assert result.status == "green"
    assert len(executed) == 1


def test_execute_with_liveness_result_unaffected_when_every_ping_fails():
    # A dead console (every ping raises) must not change the run's outcome (AC3).
    def execute(item: WorkItem) -> RunResult:
        return RunResult(status="green", pr_url="https://github.com/o/r/pull/7")

    result = _execute_with_liveness(
        _slot(_AlwaysFailPingClient(), execute), _item(), interval=0.0
    )
    assert result.status == "green"


def test_execute_with_liveness_propagates_execute_exceptions_unchanged():
    # The liveness thread must not swallow an execute() error — the fleet slot's
    # own handler maps it to an `error` RunResult, exactly as before #1388.
    def execute(item: WorkItem) -> RunResult:
        raise ValueError("boom")

    stop = threading.Event()
    client = _PingClient(stop, stop_after=1)
    try:
        _execute_with_liveness(_slot(client, execute), _item(), interval=0.0)
        raised: Optional[BaseException] = None
    except ValueError as exc:
        raised = exc
    assert isinstance(raised, ValueError)
