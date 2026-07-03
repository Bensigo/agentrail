"""Event-trigger Dispatcher — the **Heartbeat**'s event-first dispatch loop.

CONTEXT.md: the Heartbeat "dispatches queued issues — event-first (issue
labeled, CI fails on an open PR) ... It stops when the queue is empty (every
issue is green or escalated to a human)." This module is the *thin orchestration*
named in verification-contract-architecture.md (``on_event(event)``, ``tick()``;
stop on empty queue).

Design (per the issue):

- **It dispatches FROM the Issue Queue state machine** (``agentrail/afk/queue_state``)
  and **admits through the Input-Contract gate** (``agentrail/afk/input_contract``).
  It reinvents neither: an event mints a :class:`QueueEntry` via
  ``input_contract.admit_to_queue`` (which enforces machine-checkable AC), parks
  it if blocked via ``queue_state.admit``, and starts grabbable entries via
  ``queue_state.transition(entry, Event.START)``.
- **The dispatch decision is pure**: an event/tick produces decisions over the
  queue. The only I/O — fetching an issue body and *launching a run* — is injected
  (``fetch_body``, ``launch_run``) so tests use stubs, never a live agent or
  network.
- **Event-first, not a busy-loop**: ``tick()`` grabs at most the next grabbable
  entry and otherwise reports :class:`Idle`. With an empty (or fully
  non-grabbable) queue the dispatcher never launches anything (AC2).

Gating (AC3) lives in ``agentrail/heartbeat/gate.py``: a caller checks
``heartbeat_enabled(detect_capabilities())`` before wiring this dispatcher to a
real trigger source. This module stays a pure mechanism so it is unit-testable in
isolation regardless of whether the capstone is enabled.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, FrozenSet, List, Optional, Union

from agentrail.afk import input_contract
from agentrail.afk.input_contract import AdmissionLedger, WriterClass
from agentrail.afk.queue_state import (
    Event as QueueEvent,
    QueueEntry,
    QueueState,
    Tier,
    admit,
    is_terminal,
    transition,
)


class EventKind(str, Enum):
    """The event-first triggers the Heartbeat listens for (CONTEXT.md)."""

    ISSUE_LABELED = "issue_labeled"   # an issue was labeled grabbable
    CI_FAILED = "ci_failed"           # CI failed on an open PR for the issue


@dataclass(frozen=True)
class Event:
    """An external trigger: a ``kind`` and the issue ``number`` it concerns."""

    kind: EventKind
    issue: int


@dataclass(frozen=True)
class Dispatched:
    """A grabbable entry was dispatched to a run (it is now RUNNING)."""

    entry: QueueEntry


@dataclass(frozen=True)
class Idle:
    """No grabbable work — the Heartbeat is idle and launched nothing (AC2)."""

    reason: str = "queue empty: no grabbable work"


# What the I/O edges look like, injected so the core stays pure/testable.
FetchBody = Callable[[int], str]          # issue number -> issue body text
LaunchRun = Callable[[QueueEntry], None]  # actually start a run for an entry


@dataclass
class Dispatcher:
    """Holds the live **Issue Queue** and dispatches grabbable entries.

    The queue is a list of :class:`QueueEntry` from the ``queue_state`` machine —
    this dispatcher never models entries itself. ``fetch_body``/``launch_run`` are
    the injected I/O edges.
    """

    fetch_body: FetchBody
    launch_run: LaunchRun
    queue: List[QueueEntry] = field(default_factory=list)
    # The v2 admission ledger (issue #1026): duplicate-content hashes + per-writer
    # counts, threaded forward across admissions so the entrance can dedup content
    # and rate-limit each writer. Held here (not in the pure policy) so the policy
    # stays stateless; every enqueue swaps in the next ledger the gate returns.
    ledger: AdmissionLedger = field(default_factory=AdmissionLedger)

    # --- admission (through the Input-Contract gate) -------------------------

    def enqueue(
        self,
        *,
        number: int,
        blocked_by: FrozenSet[int] = frozenset(),
        open_blockers: FrozenSet[int] = frozenset(),
        writer: WriterClass = WriterClass.HUMAN_GITHUB,
    ) -> Optional[QueueEntry]:
        """Admit an issue into the queue via the Input-Contract gate (v2).

        Runs the queue-entrance checks (injection screen, machine-checkable AC,
        duplicate content, per-writer rate limit) and threads the admission ledger
        forward. Outcomes:

        * **Rejected** (injection probe / missing machine-checkable AC) → returns
          ``None``: the issue never becomes an entry (a hard REJECT).
        * **Parked** (duplicate content / writer over its rate limit) → the entry
          EXISTS in the PARKED state with a human-readable reason and is APPENDED
          to the queue (never a silent drop), so a human can review it. It is not
          grabbable, so it never runs.
        * **Admitted** → a QUEUED entry (or parked by an open ``blocked_by``
          dependency via ``queue_state.admit``) is appended.

        An issue already in the queue is not duplicated. Never raises — the gate
        converts any check failure into a reject or a park.
        """
        if any(e.number == number for e in self.queue):
            return next(e for e in self.queue if e.number == number)
        result = input_contract.admit_to_queue(
            number=number,
            issue_body=self.fetch_body(number),
            blocked_by=blocked_by,
            writer=writer,
            ledger=self.ledger,
        )
        # With a ledger supplied, admit_to_queue returns an Admission carrying the
        # next ledger to thread forward and either a rejection or a real entry.
        self.ledger = result.ledger
        if result.is_rejected:
            return None  # hard REJECT — never becomes an entry
        entry = result.entry
        # A gate-parked entry (dup/rate-limit) already carries its reason and state;
        # only run queue_state.admit for a would-be-QUEUED entry so an open blocker
        # can still park it. admit() preserves a gate park (it does not resurrect).
        admitted = admit(entry, open_blockers)
        self.queue.append(admitted)
        return admitted

    def readmit(self, *, open_blockers: FrozenSet[int]) -> None:
        """Re-run ``queue_state.admit`` over every non-terminal entry.

        Used when blockers change: a parked entry whose blockers are now resolved
        returns to QUEUED (becomes grabbable); a queued entry whose blocker
        appears is parked. Pure delegation to the state machine.
        """
        self.queue = [
            admit(e, open_blockers) if not is_terminal(e.state) else e
            for e in self.queue
        ]

    # --- grabbability & dispatch (over the queue_state machine) --------------

    @staticmethod
    def _is_grabbable(entry: QueueEntry) -> bool:
        """A QUEUED (not parked, not running, not terminal) entry is grabbable."""
        return entry.state is QueueState.QUEUED

    def is_idle(self) -> bool:
        """True when no entry is grabbable — the Heartbeat is idle (AC2)."""
        return not any(self._is_grabbable(e) for e in self.queue)

    def _dispatch(self, entry: QueueEntry) -> Dispatched:
        """Start one grabbable entry: ``queue_state`` START → RUNNING, then launch.

        The state transition is the source of truth; ``launch_run`` is the I/O
        edge that actually begins a run for the now-RUNNING entry.
        """
        started = transition(entry, QueueEvent.START)
        self.queue = [started if e.number == entry.number else e for e in self.queue]
        self.launch_run(started)
        return Dispatched(entry=started)

    def tick(self) -> Union[Dispatched, Idle]:
        """Grab and dispatch the next grabbable entry, else go idle (AC2).

        Event-first, not a busy-loop: a tick dispatches at most one grabbable
        entry. With an empty or fully non-grabbable queue it returns :class:`Idle`
        and launches nothing.
        """
        for entry in self.queue:
            if self._is_grabbable(entry):
                return self._dispatch(entry)
        return Idle()

    def on_event(self, event: Event) -> List[Dispatched]:
        """Handle an external trigger: enqueue the issue, then dispatch (AC1).

        Returns the list of entries dispatched as a result (empty if the issue was
        rejected by the Input-Contract gate or is parked by an open blocker —
        AC2's "never runs without grabbable work").
        """
        entry = self.enqueue(number=event.issue)
        if entry is None or not self._is_grabbable(entry):
            return []
        return [self._dispatch(entry)]
