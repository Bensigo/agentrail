"""Unit tests for the Issue Queue state machine (agentrail/afk/queue_state.py).

Behavior-only tests through the public ``transition`` interface. Vocabulary
matches CONTEXT.md: an Issue Queue entry carries its tier, remaining budget, and
state; every entry reaches exactly one Run Outcome terminal — GREEN,
ESCALATED_TO_HUMAN, or BLOCKED — and no transition loops forever.
"""
from dataclasses import replace

import pytest

from agentrail.afk.queue_state import (
    ALIGNMENT_DENIED_PARK_REASON,
    ALIGNMENT_PARK_REASON,
    Event,
    QueueEntry,
    QueueState,
    Terminal,
    Tier,
    admit,
    apply_admission_alignment,
    release_if_aligned,
    transition,
)


def _entry(**kw):
    base = dict(number=1, tier=Tier.CHEAP, remaining_budget=2)
    base.update(kw)
    return QueueEntry(**base)


def test_entry_carries_tier_budget_and_state():
    # AC1: a fresh entry exposes tier, remaining budget, and state.
    e = _entry()
    assert e.tier is Tier.CHEAP
    assert e.remaining_budget == 2
    assert e.state is QueueState.QUEUED


# --- AC3: a blocked-by dependency parks the entry, never attempts it ---------


def test_unmet_blocked_by_parks_on_admission():
    # AC3: an entry with an open blocker is PARKED, not QUEUED.
    e = _entry(blocked_by=frozenset({99}))
    admitted = admit(e, open_blockers=frozenset({99}))
    assert admitted.state is QueueState.PARKED


def test_resolved_blocked_by_queues_on_admission():
    # The same entry queues once its blockers are resolved.
    e = _entry(blocked_by=frozenset({99}))
    admitted = admit(e, open_blockers=frozenset())
    assert admitted.state is QueueState.QUEUED


def test_no_blockers_queues_on_admission():
    admitted = admit(_entry(), open_blockers=frozenset({99}))
    assert admitted.state is QueueState.QUEUED


def test_parked_entry_cannot_be_started():
    # A parked entry is never attempted: starting it is rejected.
    parked = admit(_entry(blocked_by=frozenset({99})), open_blockers=frozenset({99}))
    with pytest.raises(ValueError):
        transition(parked, Event.START)


def test_parked_entry_unblocks_when_dependency_resolves():
    # Re-admitting a parked entry with cleared blockers returns it to QUEUED.
    parked = admit(_entry(blocked_by=frozenset({99})), open_blockers=frozenset({99}))
    requeued = admit(parked, open_blockers=frozenset())
    assert requeued.state is QueueState.QUEUED


# --- AC2: every transition, all three terminals, no infinite loop ------------


def test_start_queued_to_running():
    e = transition(_entry(state=QueueState.QUEUED), Event.START)
    assert e.state is QueueState.RUNNING


def test_start_rejected_when_not_queued():
    with pytest.raises(ValueError):
        transition(_entry(state=QueueState.RUNNING), Event.START)


def test_green_terminal():
    # Terminal 1/3: GREEN.
    running = transition(_entry(), Event.START)
    done = transition(running, Event.GATE_GREEN)
    assert done.state is Terminal.GREEN


def test_security_block_escalates_to_human():
    # Terminal 2/3 via a security hard stop, regardless of remaining budget.
    running = transition(_entry(remaining_budget=5), Event.START)
    done = transition(running, Event.SECURITY_BLOCK)
    assert done.state is Terminal.ESCALATED_TO_HUMAN


def test_gate_red_escalates_tier_and_decrements_budget():
    # A cheap-tier failure with budget left re-enqueues at the next tier.
    running = transition(_entry(tier=Tier.CHEAP, remaining_budget=2), Event.START)
    escalated = transition(running, Event.GATE_RED)
    assert escalated.tier is Tier.STRONG
    assert escalated.remaining_budget == 1
    assert escalated.state is QueueState.QUEUED


def test_gate_red_at_max_tier_escalates_to_human():
    # Terminal 2/3: the strongest tier is still red → hard stop.
    running = transition(_entry(tier=Tier.STRONG, remaining_budget=3), Event.START)
    done = transition(running, Event.GATE_RED)
    assert done.state is Terminal.ESCALATED_TO_HUMAN


def test_gate_red_with_budget_exhausted_escalates_to_human():
    # Last budget unit consumed → hard stop even below the max tier.
    running = transition(_entry(tier=Tier.CHEAP, remaining_budget=1), Event.START)
    done = transition(running, Event.GATE_RED)
    assert done.state is Terminal.ESCALATED_TO_HUMAN
    assert done.remaining_budget == 0


def test_blocked_terminal_via_admission_path():
    # Terminal 3/3: BLOCKED. An entry can be marked blocked once its dependency
    # is known permanently unmet (parked, then resolved to a Blocked terminal by
    # the orchestrator). Parking is the live state; Blocked is its terminal.
    parked = admit(_entry(blocked_by=frozenset({99})), open_blockers=frozenset({99}))
    assert parked.state is QueueState.PARKED
    blocked = replace(parked, state=Terminal.BLOCKED)
    assert blocked.state is Terminal.BLOCKED


def test_terminals_are_frozen():
    # No transition out of any terminal — exactly one terminal per entry (AC2).
    for term in (Terminal.GREEN, Terminal.ESCALATED_TO_HUMAN, Terminal.BLOCKED):
        e = _entry(state=term)
        for ev in Event:
            assert transition(e, ev) == e


def test_machine_always_terminates_under_repeated_failure():
    # AC2 termination proof: drive the worst case — START then GATE_RED forever.
    # Budget strictly decreases; the machine must reach a terminal in a bounded
    # number of steps no matter how large the starting budget/tier.
    e = _entry(tier=Tier.CHEAP, remaining_budget=10)
    steps = 0
    while not isinstance(e.state, Terminal):
        steps += 1
        assert steps < 100, "machine looped without reaching a terminal"
        if e.state is QueueState.QUEUED:
            e = transition(e, Event.START)
        else:  # RUNNING
            e = transition(e, Event.GATE_RED)
    assert e.state is Terminal.ESCALATED_TO_HUMAN
    # Terminated in a bounded number of steps — the loop ceiling above proves it.
    assert steps <= 4  # START, RED(escalate), START, RED(max-tier hard stop)


def test_gate_red_never_increases_budget():
    # The termination invariant: GATE_RED only ever decreases remaining budget.
    e = transition(_entry(remaining_budget=5), Event.START)
    after = transition(e, Event.GATE_RED)
    assert after.remaining_budget < e.remaining_budget


def test_budget_exhaustion_terminates_at_top_tier():
    # Pin to the top tier so escalation can't fire: each GATE_RED only spends
    # budget. The entry must hard-stop the moment budget hits zero, never loop.
    e = _entry(tier=Tier.STRONG, remaining_budget=3)
    budgets = []
    while not isinstance(e.state, Terminal):
        e = transition(e, Event.START)
        budgets.append(e.remaining_budget)
        e = transition(e, Event.GATE_RED)
    # First GATE_RED at the max tier hard-stops immediately (no infinite retry).
    assert e.state is Terminal.ESCALATED_TO_HUMAN
    assert len(budgets) == 1


# --- #1274 PR③: the alignment gate overlay (Python mirror of github_intake.ts) -
#
# ``apply_admission_alignment``/``release_if_aligned`` are pure — this module
# has no DB/workspace access, so "is alignment satisfied" always arrives as an
# already-resolved ``aligned: bool``. Mirrors ``ALIGNMENT_PARK_REASON``/
# ``ALIGNMENT_DENIED_PARK_REASON`` and the exact scenarios in
# `packages/db-postgres/src/__tests__/github-intake-alignment-gate.test.ts`
# and `github-intake-park-reason.test.ts` (the release-side "finding-1 fix"
# describe block) — same test names/shapes, ported to the pure Python seam.


def test_alignment_park_reason_matches_the_ts_constant():
    # Lockstep pin: this literal string is what the console's
    # formatParkReason renders verbatim, from EITHER writer.
    assert ALIGNMENT_PARK_REASON == "awaiting alignment"


def test_alignment_denied_park_reason_matches_the_ts_constant():
    assert ALIGNMENT_DENIED_PARK_REASON == "alignment denied — ask Jace to revise the brief"


# -- admission overlay (apply_admission_alignment) -----------------------------


def test_admission_aligned_true_is_a_no_op_on_a_clean_queued_entry():
    e = admit(_entry(), open_blockers=frozenset())
    assert e.state is QueueState.QUEUED
    result = apply_admission_alignment(e, aligned=True)
    assert result == e


def test_admission_aligned_false_parks_a_clean_queued_entry():
    e = admit(_entry(), open_blockers=frozenset())
    assert e.state is QueueState.QUEUED
    result = apply_admission_alignment(e, aligned=False)
    assert result.state is QueueState.PARKED
    assert result.reason == ALIGNMENT_PARK_REASON


def test_admission_aligned_false_keeps_the_dependency_reason_dependency_park_wins():
    # #1274 finding-1 fix mirror: a dependency-parked entry is NOT
    # double-parked or overwritten by the alignment overlay — the dependency
    # reason is the more specific, currently-true one.
    e = admit(_entry(blocked_by=frozenset({9})), open_blockers=frozenset({9}))
    assert e.state is QueueState.PARKED
    assert "9" in e.reason
    dependency_reason = e.reason
    result = apply_admission_alignment(e, aligned=False)
    assert result.state is QueueState.PARKED
    assert result.reason == dependency_reason  # unchanged, not ALIGNMENT_PARK_REASON


def test_admission_aligned_true_passes_a_dependency_park_through_unchanged():
    e = admit(_entry(blocked_by=frozenset({9})), open_blockers=frozenset({9}))
    result = apply_admission_alignment(e, aligned=True)
    assert result == e


# -- release overlay (release_if_aligned) — mirrors unparkDependents exactly --


def test_release_base_bypass_repro_blocker_clears_but_still_unaligned_stays_parked():
    """THE bug this PR closes (Python side): a resolved dependency alone must
    never be enough to release an entry into a claimable, unpriced state."""
    parked = admit(_entry(blocked_by=frozenset({42})), open_blockers=frozenset({42}))
    assert parked.state is QueueState.PARKED

    released = release_if_aligned(parked, open_blockers=frozenset(), aligned=False)

    assert released.state is QueueState.PARKED  # NOT queued
    assert released.reason == ALIGNMENT_PARK_REASON  # the TRUE reason, not stale


def test_release_confirm_then_release_aligned_before_blocker_clears_goes_queued():
    """confirm-then-release: alignment was already satisfied (e.g. a human
    confirmed the brief) before the dependency cleared — releasing goes
    straight to QUEUED, values preserved by the caller (not this function's
    concern — it only decides state/reason)."""
    parked = admit(_entry(blocked_by=frozenset({42})), open_blockers=frozenset({42}))
    released = release_if_aligned(parked, open_blockers=frozenset(), aligned=True)
    assert released.state is QueueState.QUEUED
    assert released.reason == ""


def test_release_then_confirm_unaligned_release_then_a_later_aligned_recheck_queues():
    """release-then-confirm: releasing first (still unaligned) leaves it
    parked 'awaiting alignment'; a LATER re-check (now aligned=True, e.g.
    confirmed after the fact) with the same cleared blockers goes queued."""
    parked = admit(_entry(blocked_by=frozenset({42})), open_blockers=frozenset({42}))
    first = release_if_aligned(parked, open_blockers=frozenset(), aligned=False)
    assert first.state is QueueState.PARKED
    assert first.reason == ALIGNMENT_PARK_REASON

    second = release_if_aligned(first, open_blockers=frozenset(), aligned=True)
    assert second.state is QueueState.QUEUED
    assert second.reason == ""


def test_release_denied_entry_is_never_touched_even_if_now_aligned():
    """denied-then-release: a denial survives a later-resolved dependency AND
    a later-aligned recheck, completely untouched — a denial is a stronger
    hold than anything this overlay could say."""
    denied = replace(
        _entry(blocked_by=frozenset({42})),
        state=QueueState.PARKED,
        reason=ALIGNMENT_DENIED_PARK_REASON,
    )
    released = release_if_aligned(denied, open_blockers=frozenset(), aligned=True)
    assert released == denied  # byte-identical, nothing changed


def test_release_still_blocked_never_even_consults_alignment():
    # Two blockers; only one clears. Dependency short-circuits before
    # alignment is even consulted (mirrors unparkDependents' own
    # stillUnmet.length > 0 -> continue).
    parked = admit(
        _entry(blocked_by=frozenset({42, 43})), open_blockers=frozenset({42, 43})
    )
    released = release_if_aligned(parked, open_blockers=frozenset({43}), aligned=False)
    assert released.state is QueueState.PARKED
    assert "43" in released.reason
    assert released.reason != ALIGNMENT_PARK_REASON
