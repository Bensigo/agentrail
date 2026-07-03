"""Issue Queue state machine — the *execution* state machine (ADR 0010/0011).

This is a **deep module** (verification-contract-architecture.md): pure logic, no
I/O, deterministic, unit-tested in isolation. It models how a single **Issue
Queue** entry moves through states to exactly one **Run Outcome** terminal. It
imports nothing from the pipeline, network, or DB; persistence and the server
read model (``agentrail/server/queue.py``) live at the edges and project this
state, never the reverse.

Vocabulary is from ``CONTEXT.md``:

- **Issue Queue** entry — carries its *tier* (which model), *remaining budget*,
  and *state*.
- **Run Outcome (terminal states)** — every entry leaves the queue in exactly one
  of: **Green** (Objective Gate + Independent Verification pass → PR ready),
  **Escalated-to-human** (a hard stop fired; budget exhausted even after
  escalation, max tier still red, repeated verification failure, or a security
  block), or **Blocked** (an explicit ``blocked-by`` dependency is unmet → parked).
- **Escalation** is a queue transition: re-enqueue at a higher *tier* with a
  decremented *budget* (ADR 0011's Budget Leash).

Termination guarantee (AC2): every event that does not reach a terminal strictly
*decreases* the integer ``remaining_budget`` toward zero, and budget can never
increase. Because the only non-terminal transitions decrement a bounded
non-negative integer, no sequence of transitions can loop forever — budget
exhaustion forces the ``ESCALATED_TO_HUMAN`` terminal. There is no state from
which the machine can cycle indefinitely.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
from typing import FrozenSet


class Tier(int, Enum):
    """Which model an entry runs on. Ordered cheap → strong so escalation is a
    strict increase; ``STRONG`` is the maximum tier (no tier above it)."""

    CHEAP = 0
    STRONG = 1


# The highest tier available. Reaching it with the gate still red is a hard stop.
MAX_TIER = Tier.STRONG


class QueueState(str, Enum):
    """Non-terminal lifecycle states of a queue entry."""

    QUEUED = "queued"        # awaiting a slot; blockers (if any) are resolved
    PARKED = "parked"        # withheld: an explicit blocked-by dependency is unmet
    RUNNING = "running"      # an agent is attempting it on the current tier


class Terminal(str, Enum):
    """The three **Run Outcome** terminals. Exactly one is ever reached."""

    GREEN = "green"                          # Objective Gate + verification pass
    ESCALATED_TO_HUMAN = "escalated-to-human"  # a hard stop fired; state preserved
    BLOCKED = "blocked"                      # an unmet blocked-by dependency


# A state value is terminal when it is a ``Terminal`` member.
def is_terminal(state: object) -> bool:
    return isinstance(state, Terminal)


@dataclass(frozen=True)
class QueueEntry:
    """One **Issue Queue** entry. Carries tier, remaining budget, and state (AC1).

    ``state`` is either a non-terminal :class:`QueueState` or, once the entry has
    left the queue, a :class:`Terminal`.
    """

    number: int
    tier: Tier = Tier.CHEAP
    remaining_budget: int = 2
    state: object = QueueState.QUEUED
    # Issue numbers this entry is blocked by; parked while any is still open.
    blocked_by: FrozenSet[int] = frozenset()
    # Human-readable reason the entry is parked/withheld, retrievable as STATE
    # (not a log line): empty for an ordinary QUEUED/RUNNING entry, populated when
    # the entry is PARKED (an unmet blocked-by dependency, a duplicate-content
    # admission, or a writer over its rate limit). Surfaced to humans reviewing
    # the queue so a parked entry always explains itself.
    reason: str = ""


class Event(str, Enum):
    """The inputs that drive a queue entry's transitions.

    These are the *outcomes the orchestrator observes*, not steps it chooses:

    - ``START`` — a slot picks the entry up; it begins running on its tier.
    - ``GATE_GREEN`` — Objective Gate + Independent Verification passed.
    - ``GATE_RED`` — the attempt failed the gate (consumes one budget unit).
    - ``SECURITY_BLOCK`` — a security policy block fired (a hard stop).
    """

    START = "start"
    GATE_GREEN = "gate_green"
    GATE_RED = "gate_red"
    SECURITY_BLOCK = "security_block"


def admit(entry: QueueEntry, open_blockers: FrozenSet[int]) -> QueueEntry:
    """Decide whether an entry may sit in the queue or must be parked (AC3).

    Pure. An entry with any unmet ``blocked_by`` dependency is PARKED rather than
    attempted; once its blockers are resolved the same entry returns to QUEUED.
    Terminal entries are returned unchanged — admission never resurrects them.

    An entry that arrives ALREADY parked with a reason (e.g. the Input-Contract
    gate parked it for duplicate content or a writer rate limit) keeps that
    parked state and reason here — blocker admission never overrides a gate park
    nor silently promotes it to QUEUED. Only an entry whose sole reason to park
    is an unmet blocker is returned to QUEUED once its blockers clear.
    """
    if is_terminal(entry.state):
        return entry
    unmet = bool(open_blockers and (entry.blocked_by & open_blockers))
    if unmet:
        blocked = sorted(entry.blocked_by & open_blockers)
        reason = f"blocked-by unmet dependency: {', '.join(f'#{n}' for n in blocked)}"
        return replace(entry, state=QueueState.PARKED, reason=reason)
    # No unmet blocker. If the gate already parked this entry for a non-blocker
    # reason (duplicate content / rate limit), preserve that park — do not
    # resurrect it to QUEUED. Otherwise it is grabbable and carries no reason.
    if entry.state is QueueState.PARKED and entry.reason and not entry.blocked_by:
        return entry
    return replace(entry, state=QueueState.QUEUED, reason="")


def transition(entry: QueueEntry, event: Event) -> QueueEntry:
    """Apply one ``event`` to an entry, returning the next entry. Pure.

    Reaches exactly one terminal and never loops forever (AC2):

    - A terminal entry is frozen — applying any event returns it unchanged.
    - A PARKED entry is never attempted: ``START`` is rejected (AC3). Parking is
      cleared by :func:`admit`, not by an event.
    - ``GATE_GREEN`` → :attr:`Terminal.GREEN`.
    - ``SECURITY_BLOCK`` → :attr:`Terminal.ESCALATED_TO_HUMAN` (a hard stop).
    - ``GATE_RED`` consumes one budget unit, then either escalates to the next
      tier (re-enqueue at a higher tier with a decremented budget) or, when the
      budget is exhausted or the max tier is already red, hard-stops to
      :attr:`Terminal.ESCALATED_TO_HUMAN`.

    Termination: the only non-terminal-producing event is ``GATE_RED``, and it
    strictly decreases the non-negative integer ``remaining_budget``. No
    transition increases it. A bounded, strictly-decreasing counter cannot cycle,
    so the machine always reaches a terminal in finitely many steps.
    """
    if is_terminal(entry.state):
        return entry  # terminals are frozen — no transition out

    if entry.state is QueueState.PARKED:
        raise ValueError(
            f"entry #{entry.number} is parked by an unmet blocked-by dependency; "
            "resolve it via admit() before attempting"
        )

    if event is Event.START:
        if entry.state is not QueueState.QUEUED:
            raise ValueError(
                f"cannot start entry #{entry.number}: state is {entry.state}"
            )
        return replace(entry, state=QueueState.RUNNING)

    if event is Event.GATE_GREEN:
        return replace(entry, state=Terminal.GREEN)

    if event is Event.SECURITY_BLOCK:
        # A security block is a hard stop: preserve state for a human.
        return replace(entry, state=Terminal.ESCALATED_TO_HUMAN)

    if event is Event.GATE_RED:
        remaining = entry.remaining_budget - 1  # consume one budget unit
        if remaining <= 0 or entry.tier >= MAX_TIER:
            # Budget exhausted even after escalation, or the strongest tier is
            # still red: hard stop, never an infinite retry.
            return replace(
                entry, remaining_budget=max(remaining, 0),
                state=Terminal.ESCALATED_TO_HUMAN,
            )
        # Escalate: re-enqueue at the next tier with the decremented budget.
        return replace(
            entry,
            tier=Tier(entry.tier + 1),
            remaining_budget=remaining,
            state=QueueState.QUEUED,
        )

    raise TypeError(f"unknown event: {event!r}")  # pragma: no cover
