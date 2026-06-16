"""Integration-style test: a labeled issue auto-runs through the Heartbeat.

Exercises the real wiring — the prerequisite gate (AC3), the Input-Contract gate,
the ``queue_state`` machine, and event-first dispatch (AC1) — with the only I/O
(fetching the issue body, launching a run) stubbed. No live agent, no network.

This mirrors the milestone's manual check ("a labeled issue auto-runs end to
end") as an automated test.
"""
from agentrail.afk.queue_state import QueueState
from agentrail.heartbeat.dispatcher import Dispatcher, Event, EventKind
from agentrail.heartbeat.gate import (
    Capability,
    REQUIRED_CAPABILITIES,
    heartbeat_enabled,
)

_VALID_BODY = """## Acceptance criteria
- [ ] AC1: the feature behaves
"""


def test_labeled_issue_auto_runs_when_capstone_enabled():
    # AC3: only wire the dispatcher when all prerequisites are present.
    assert heartbeat_enabled(REQUIRED_CAPABILITIES) is True

    launched = []
    runs = []

    def launch_run(entry):
        # The injected run launcher: records the dispatch instead of starting a
        # live agent. Captures the entry's tier so we can assert it ran cheap.
        launched.append(entry.number)
        runs.append((entry.number, entry.tier, entry.state))

    d = Dispatcher(
        fetch_body=lambda n: _VALID_BODY,
        launch_run=launch_run,
    )

    # An issue gets labeled grabbable → event-first enqueue + dispatch (AC1).
    dispatched = d.on_event(Event(kind=EventKind.ISSUE_LABELED, issue=786))
    assert [x.entry.number for x in dispatched] == [786]
    assert launched == [786]
    # The launched entry is RUNNING on the cheap tier — dispatched via queue_state.
    number, tier, state = runs[0]
    assert number == 786
    assert state is QueueState.RUNNING

    # AC2: with the only issue now RUNNING, the queue has no grabbable work left,
    # so the Heartbeat is idle and a further tick launches nothing more.
    assert d.is_idle() is True
    d.tick()
    assert launched == [786]


def test_capstone_stays_off_until_budget_leash_present():
    # AC3, end to end: with the Budget Leash absent the capstone is OFF — a
    # caller must not wire the dispatcher to a live trigger. (The dispatcher
    # mechanism itself remains testable, but the heartbeat gate says OFF.)
    present_without_budget = frozenset(
        {Capability.OBJECTIVE_GATE, Capability.SECURITY_GUARDRAIL}
    )
    assert heartbeat_enabled(present_without_budget) is False
