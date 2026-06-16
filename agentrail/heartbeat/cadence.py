"""Scheduled **Cadence** — the Heartbeat's scheduled-cadence *fallback* path.

CONTEXT.md: the **Heartbeat** is *event-first* (issue labeled, CI fails on an
open PR) "with a scheduled-cadence fallback (scan backlog, run grabbable issues,
post a triage summary). It stops when the queue is empty." This module is that
fallback path — the event-trigger ``Dispatcher`` (#786) is the event-first path;
this is the scheduled one. The two are the same **Heartbeat** package and stay
gated by the same prerequisite gate (``agentrail/heartbeat/gate.py``).

Design (matching the dispatcher's deep-module shape):

- **It reuses the** :class:`~agentrail.heartbeat.dispatcher.Dispatcher` to do the
  actual dispatch. It does NOT reinvent enqueue/grabbability/launch — it enqueues
  each backlog issue through the same Input-Contract gate and dispatches the
  grabbable ones via ``dispatcher.tick()`` (AC1).
- **The triage summary is pure**: :class:`TriageSummary` is a function of the
  *finished* :class:`~agentrail.afk.queue_state.QueueEntry` set
  (backlog + finished-entries → decisions). It buckets each **Run Outcome**
  terminal into the milestone's triage categories: Green → *merged*,
  Escalated-to-human → *escalated*, Blocked → *failed* (AC2).
- **Posting is injected**: the summary is posted *via a connector/notifier* that
  is injected (``connector``), so tests use a fake and the cadence does not
  hard-depend on a specific connector (e.g. the #785 Discord adapter built in
  parallel). The only I/O — launching runs (on the dispatcher) and posting the
  summary (on the connector) — lives at the edges.
- **Stops on empty** (AC3): when there is no grabbable work *and* nothing
  finished to report, the cadence is a no-op — it dispatches nothing and posts no
  summary (no spam).

Determinism: the core is ``backlog`` + ``finished`` → decisions. It never reads a
real clock; ``run`` takes its inputs as arguments so it is fully reproducible in
tests.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, FrozenSet, Iterable, List, Optional, Protocol, Sequence

from agentrail.afk.queue_state import QueueEntry, Terminal
from agentrail.heartbeat.dispatcher import Dispatched, Dispatcher


class TriageCategory(str, Enum):
    """The three morning-triage categories (the milestone's wording).

    Each maps one-to-one onto a **Run Outcome** terminal from the Issue Queue
    state machine, so the summary speaks the same vocabulary as the queue:

    - ``MERGED``    ← :attr:`Terminal.GREEN` (Objective Gate + verification passed)
    - ``ESCALATED`` ← :attr:`Terminal.ESCALATED_TO_HUMAN` (a hard stop fired)
    - ``FAILED``    ← :attr:`Terminal.BLOCKED` (an unmet blocked-by dependency)
    """

    MERGED = "merged"
    ESCALATED = "escalated"
    FAILED = "failed"

    @staticmethod
    def for_terminal(terminal: Terminal) -> "TriageCategory":
        """Map a **Run Outcome** terminal to its triage category. Pure."""
        return _TERMINAL_TO_CATEGORY[terminal]


_TERMINAL_TO_CATEGORY: Dict[Terminal, TriageCategory] = {
    Terminal.GREEN: TriageCategory.MERGED,
    Terminal.ESCALATED_TO_HUMAN: TriageCategory.ESCALATED,
    Terminal.BLOCKED: TriageCategory.FAILED,
}


@dataclass(frozen=True)
class TriageSummary:
    """A morning triage summary categorized as merged / escalated / failed (AC2).

    Pure data derived from the finished :class:`QueueEntry` set. Issue numbers are
    kept in their input order within each bucket so the summary is deterministic.
    """

    merged: List[int] = field(default_factory=list)
    escalated: List[int] = field(default_factory=list)
    failed: List[int] = field(default_factory=list)

    @classmethod
    def from_finished(cls, finished: Iterable[QueueEntry]) -> "TriageSummary":
        """Bucket each finished entry under its triage category. Pure.

        Non-terminal entries are ignored — only entries that have reached a
        **Run Outcome** terminal belong in a triage summary.
        """
        buckets: Dict[TriageCategory, List[int]] = {
            TriageCategory.MERGED: [],
            TriageCategory.ESCALATED: [],
            TriageCategory.FAILED: [],
        }
        for entry in finished:
            if isinstance(entry.state, Terminal):
                buckets[TriageCategory.for_terminal(entry.state)].append(entry.number)
        return cls(
            merged=buckets[TriageCategory.MERGED],
            escalated=buckets[TriageCategory.ESCALATED],
            failed=buckets[TriageCategory.FAILED],
        )

    @property
    def is_empty(self) -> bool:
        """True when there is nothing to report in any category."""
        return not (self.merged or self.escalated or self.failed)

    def render(self) -> str:
        """Render the summary as a short human-readable triage line. Pure."""
        return "\n".join(
            [
                "Morning triage summary",
                f"- merged: {self._fmt(self.merged)}",
                f"- escalated: {self._fmt(self.escalated)}",
                f"- failed: {self._fmt(self.failed)}",
            ]
        )

    @staticmethod
    def _fmt(numbers: Sequence[int]) -> str:
        if not numbers:
            return "none"
        return ", ".join(f"#{n}" for n in numbers)


class TriageNotifier(Protocol):
    """The injectable seam the cadence posts the triage summary through.

    Any object with ``post_triage_summary(summary)`` satisfies it — a real
    connector adapter (e.g. a notify connector) or a test fake. The cadence does
    not hard-depend on a specific connector; #785's Discord adapter is built in
    parallel.
    """

    def post_triage_summary(self, summary: TriageSummary) -> None:  # pragma: no cover
        ...


@dataclass(frozen=True)
class CadenceOutcome:
    """What one cadence sweep did: who it dispatched and what it posted.

    ``summary`` is ``None`` when the cadence was a no-op (nothing finished to
    report — AC3's "stops on empty").
    """

    dispatched: List[Dispatched] = field(default_factory=list)
    summary: Optional[TriageSummary] = None


@dataclass
class Cadence:
    """The scheduled-cadence fallback: scan backlog → dispatch → post summary.

    Reuses an injected :class:`Dispatcher` for all queue work and an injected
    :class:`TriageNotifier` to post the summary.
    """

    dispatcher: Dispatcher
    connector: TriageNotifier

    def run(
        self,
        *,
        backlog: Sequence[int],
        finished: Optional[Sequence[QueueEntry]] = None,
        open_blockers: Optional[Dict[int, FrozenSet[int]]] = None,
    ) -> CadenceOutcome:
        """Run one scheduled sweep (AC1/AC2/AC3).

        - ``backlog`` — issue numbers a connector found in the backlog this sweep.
        - ``finished`` — entries that have reached a **Run Outcome** terminal
          since the last sweep, to report in the triage summary.
        - ``open_blockers`` — per-issue unmet ``blocked-by`` dependencies; an issue
          with an open blocker is parked (not grabbable) and never dispatched.

        Scans the backlog and dispatches the grabbable issues via the reused
        dispatcher (AC1), then posts a triage summary categorized merged /
        escalated / failed through the injected connector (AC2). When there is no
        grabbable work *and* nothing finished to report, it does nothing — no
        dispatch, no summary (AC3, "stops on empty").
        """
        open_blockers = open_blockers or {}

        # AC1: scan the backlog, admit each issue through the Input-Contract gate
        # (reusing the dispatcher's enqueue), then dispatch the grabbable ones.
        for number in backlog:
            blockers = open_blockers.get(number, frozenset())
            self.dispatcher.enqueue(
                number=number,
                blocked_by=blockers,
                open_blockers=blockers,
            )

        dispatched: List[Dispatched] = []
        while not self.dispatcher.is_idle():
            result = self.dispatcher.tick()
            if isinstance(result, Dispatched):
                dispatched.append(result)
            else:  # pragma: no cover - is_idle guards this, defensive only
                break

        # AC2/AC3: report finished runs. With nothing finished, stay silent — a
        # clean no-op rather than posting an empty summary (no spam).
        summary = TriageSummary.from_finished(finished or [])
        if summary.is_empty:
            return CadenceOutcome(dispatched=dispatched, summary=None)

        self.connector.post_triage_summary(summary)
        return CadenceOutcome(dispatched=dispatched, summary=summary)
