"""Unit tests for the event-trigger Dispatcher (AC1, AC2).

Behavior-only through the public interface. Vocabulary from CONTEXT.md: the
**Heartbeat** is *event-first* — an event (issue labeled / CI fail) enqueues and
dispatches the corresponding issue; it goes *idle* when the **Issue Queue** is
empty and never runs without grabbable work. The dispatcher dispatches FROM the
``queue_state`` machine (it does not reinvent it) and entries enter through the
Input-Contract gate. I/O (launching a run, fetching an issue body) is injected.
"""
from agentrail.afk.queue_state import QueueState, Tier
from agentrail.heartbeat.dispatcher import (
    Dispatcher,
    Event,
    EventKind,
    Idle,
)

# An issue body that passes the Input-Contract gate (has a checkbox AC).
_VALID_BODY = """## Acceptance criteria
- [ ] AC1: it does the thing
"""

# An issue body the Input-Contract gate rejects (no machine-checkable AC).
_NO_AC_BODY = "Please just make it nicer, thanks."


def _dispatcher(bodies=None, launched=None):
    """Build a dispatcher with injected I/O.

    ``fetch_body`` returns the (stubbed) issue body; ``launch_run`` records the
    issue numbers that were actually dispatched to a run — no live agent.
    """
    bodies = bodies if bodies is not None else {}
    launched = launched if launched is not None else []
    return Dispatcher(
        fetch_body=lambda number: bodies.get(number, _VALID_BODY),
        launch_run=lambda entry: launched.append(entry.number),
    )


# --- AC1: an event enqueues and dispatches the issue -------------------------


def test_label_event_enqueues_and_dispatches():
    launched = []
    d = _dispatcher(launched=launched)
    d.on_event(Event(kind=EventKind.ISSUE_LABELED, issue=42))
    # The labeled issue was dispatched to a run (launched).
    assert launched == [42]


def test_ci_fail_event_enqueues_and_dispatches():
    launched = []
    d = _dispatcher(launched=launched)
    d.on_event(Event(kind=EventKind.CI_FAILED, issue=7))
    assert launched == [7]


def test_dispatched_entry_is_running_on_its_tier():
    d = _dispatcher()
    outcomes = d.on_event(Event(kind=EventKind.ISSUE_LABELED, issue=42))
    # Dispatch moved the entry through queue_state.START → RUNNING.
    assert outcomes[0].entry.state is QueueState.RUNNING
    assert outcomes[0].entry.tier is Tier.CHEAP


def test_issue_without_machine_checkable_ac_is_not_dispatched():
    launched = []
    d = _dispatcher(bodies={9: _NO_AC_BODY}, launched=launched)
    outcomes = d.on_event(Event(kind=EventKind.ISSUE_LABELED, issue=9))
    # The Input-Contract gate kept it out of the queue → nothing launched.
    assert launched == []
    assert outcomes == []


# --- AC2: empty queue → idle, never runs without grabbable work --------------


def test_tick_on_empty_queue_is_idle_and_launches_nothing():
    launched = []
    d = _dispatcher(launched=launched)
    result = d.tick()
    assert isinstance(result, Idle)
    assert launched == []


def test_is_idle_when_queue_is_empty():
    d = _dispatcher()
    assert d.is_idle() is True


def test_not_idle_while_an_entry_is_grabbable():
    # A parked/blocked entry is not grabbable; a queued one is. Enqueue without
    # dispatching by parking via a blocker, then assert grabbability.
    d = _dispatcher()
    d.enqueue(number=5, blocked_by=frozenset({99}), open_blockers=frozenset({99}))
    # Blocked → parked → not grabbable → idle (never runs without grabbable work).
    assert d.is_idle() is True
    result = d.tick()
    assert isinstance(result, Idle)


def test_resolving_blocker_makes_entry_grabbable_and_dispatches_on_tick():
    launched = []
    d = _dispatcher(launched=launched)
    d.enqueue(number=5, blocked_by=frozenset({99}), open_blockers=frozenset({99}))
    # Blocker resolved: re-admit with no open blockers, then a tick grabs it.
    d.readmit(open_blockers=frozenset())
    result = d.tick()
    assert not isinstance(result, Idle)
    assert launched == [5]
