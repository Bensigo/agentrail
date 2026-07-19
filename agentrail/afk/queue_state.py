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


# --- Alignment gate overlay (#1274 PR ③) --------------------------------------
#
# This module has no DB/workspace access (its own "no I/O" charter, module
# docstring above) — whether a workspace REQUIRES alignment, and whether THIS
# entry already carries a sanctioned budget, are facts the impure persistence
# edge (``queue_store.py``) resolves and passes in as a plain ``aligned: bool``.
# These two functions apply ONLY the vocabulary/state overlay on top of that
# already-resolved fact — the Python mirror of
# ``packages/db-postgres/src/queries/github_intake.ts``'s ``enqueueGithubIssue``
# (admission overlay, below) and ``unparkDependents`` (release overlay,
# further below): same reason strings, same "dependency/v2-guardrail park
# always wins the reason", same "a denial is never touched" rule — so the two
# writers (Python heartbeat/webhook intake, TS console intake) leave rows the
# console cannot tell apart.

#: The exact, house-format park reason both writers use when an entry is
#: withheld for alignment alone. MUST stay byte-identical to
#: ``ALIGNMENT_PARK_REASON`` in
#: ``packages/db-postgres/src/queries/github_intake.ts`` — the console's
#: ``formatParkReason`` renders the stored reason verbatim, so a human sees
#: this literal string regardless of which writer parked the row.
ALIGNMENT_PARK_REASON = "awaiting alignment"

#: The exact denial reason. Also must stay byte-identical to the TS constant
#: of the same name. A row carrying this reason is NEVER touched by either
#: writer's release path — a denial is a stronger hold than a resolved
#: dependency or blocker.
ALIGNMENT_DENIED_PARK_REASON = "alignment denied — ask Jace to revise the brief"


def apply_admission_alignment(entry: QueueEntry, *, aligned: bool) -> QueueEntry:
    """Admission-time alignment overlay — apply AFTER :func:`admit`, never woven
    into it. Mirrors ``enqueueGithubIssue``'s inline overlay (the #1274
    finding-1 fix): alignment is evaluated INDEPENDENTLY of the dependency
    outcome, but the STORED reason only changes when the entry would
    otherwise land QUEUED clean — an already-parked entry (an unmet
    ``blocked_by`` dependency, or a v2 guardrail park the caller must skip
    this for entirely — see ``queue_store.enqueue``'s own ``v2_parked`` guard)
    keeps its own, currently-true reason. A future release re-check
    (:func:`release_if_aligned`) is what surfaces the TRUE "awaiting
    alignment" reason once that other park clears.

    Pure. ``aligned=True`` is always a no-op (workspace does not require
    alignment, or — not reachable from Python's own admission path today,
    since it never writes a confirmed value at insert time — sanctioned
    values already exist). ``aligned=False`` only ever touches a QUEUED entry.
    """
    if aligned or entry.state != QueueState.QUEUED:
        return entry
    return replace(entry, state=QueueState.PARKED, reason=ALIGNMENT_PARK_REASON)


def release_if_aligned(
    entry: QueueEntry, open_blockers: FrozenSet[int], *, aligned: bool
) -> QueueEntry:
    """Release-time alignment overlay — the Python mirror of ``unparkDependents``.

    Re-admits ``entry`` via :func:`admit` (the pure dependency decision,
    unchanged) and then alignment-gates the result EXACTLY like
    ``unparkDependents`` gates its own release:

    - A denied entry (``entry.reason == ALIGNMENT_DENIED_PARK_REASON``) is
      NEVER touched — returned unchanged, before :func:`admit` even runs. A
      denial is a stronger hold than a resolved dependency (mirrors
      ``unparkDependents``'s own "a denial always wins" rule).
    - Otherwise: if every declared blocker is now met (:func:`admit` would
      return QUEUED) AND ``aligned`` is True, the entry is released to
      QUEUED — the pre-existing dependency-only release behaviour,
      byte-identical when alignment was never in the picture.
    - If every blocker is met but ``aligned`` is False, the entry STAYS
      PARKED but its reason flips to :data:`ALIGNMENT_PARK_REASON` — the
      dependency is no longer why it's stuck, so the stale "blocked-by"
      reason is replaced with the TRUE one (mirrors ``unparkDependents``'s
      "the brief already exists... just make the stored reason honest"
      comment). THIS is the exact bypass class closed here: the caller MUST
      pass the row's real ``estimated_budget_usd IS NOT NULL`` (or
      workspace-does-not-require-alignment) fact as ``aligned`` — a
      dependency clearing alone is never enough to release an entry into a
      claimable, unpriced state.
    - If a blocker is still unmet, :func:`admit` parks it for the dependency
      reason exactly as before — alignment is not even consulted (mirrors
      ``unparkDependents``'s own "still blocked: parkReason is left exactly
      as-is" short-circuit).

    NOTE (verified while building this PR): Python's live heartbeat/webhook
    loop (``agentrail/heartbeat/runtime.py``) has no caller that re-admits a
    dependency-parked row once its blocker clears — ``queue_entries``
    re-enqueue is ``ON CONFLICT DO NOTHING`` (never resurrects/updates an
    existing row), and no live sweep re-invokes :func:`admit` against an
    already-persisted PARKED row today. This function exists so that gap is
    closed at the pure-decision layer NOW, before any live release trigger is
    wired — mirroring the TS fix exactly, ready for the day a Python release
    caller exists, rather than leaving the same bypass latent in the pure
    state machine for a future caller to reintroduce.
    """
    if entry.reason == ALIGNMENT_DENIED_PARK_REASON:
        return entry
    released = admit(entry, open_blockers)
    if released.state == QueueState.QUEUED and not aligned:
        return replace(released, state=QueueState.PARKED, reason=ALIGNMENT_PARK_REASON)
    return released


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
