"""Tests for the escalate-on-failure routing in agentrail/run/routing.py (M036).

CONTEXT.md / ADR 0011 — difficulty is *revealed, not predicted*: execute first on
the CHEAP tier; when the **Objective Gate** comes back red WITH budget remaining,
escalate to the STRONGER tier carrying a compacted failure handoff. Escalation is
modelled as an **Issue Queue** transition (re-enqueue at a higher tier with a
decremented budget), and the decision of whether to escalate is the **Budget
Leash** (``budget_leash.check``). This module reuses both rather than rolling its
own retry loop.

These tests drive the routing through its public interface with plain inputs —
the routing functions are pure (no agent calls, no I/O), so the cheap→strong
escalation carrying the handoff is exercised hermetically, mirroring the
deep-module test style of ``tests/run/test_budget_leash.py`` and
``tests/run/test_objective_gate.py``.
"""
from __future__ import annotations

import pytest

from agentrail.afk.queue_state import QueueEntry, QueueState, Terminal, Tier
from agentrail.run.budget_leash import Decision
from agentrail.run.routing import (
    EscalationOutcome,
    escalate_on_failure,
    next_tier,
)


GOAL = "Add a --json flag to `agentrail status`."
CHEAP_DIFF = "diff --git a/status.py b/status.py\n+    print(json.dumps(payload))\n"
GATE_ERROR = ["tests", "acceptance-criteria not satisfied"]


# ---------------------------------------------------------------------------
# next_tier — the pure tier step used when escalating (CONTEXT.md "Model router")
# ---------------------------------------------------------------------------

def test_next_tier_steps_cheap_to_strong() -> None:
    assert next_tier(Tier.CHEAP) is Tier.STRONG


def test_next_tier_at_max_returns_none() -> None:
    # STRONG is the maximum tier — there is no tier above it to escalate to.
    assert next_tier(Tier.STRONG) is None


# ---------------------------------------------------------------------------
# AC1 — the first attempt runs on the cheap tier
# ---------------------------------------------------------------------------

def test_first_attempt_entry_is_on_cheap_tier() -> None:
    entry = QueueEntry(number=42)
    assert entry.tier is Tier.CHEAP


def test_gate_green_on_cheap_does_not_escalate() -> None:
    """Under budget with a green gate: no escalation — the cheap tier was enough."""
    entry = QueueEntry(number=42, tier=Tier.CHEAP, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=entry,
        spent=0.5,
        ceiling=2.0,
        attempt_limit=3,
        attempts=1,
        gate_red=False,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    assert outcome.decision is Decision.CONTINUE
    assert outcome.entry.tier is Tier.CHEAP
    assert outcome.handoff is None


# ---------------------------------------------------------------------------
# AC2 — gate-fail with budget left escalates cheap→strong carrying the handoff
# ---------------------------------------------------------------------------

def test_gate_red_with_budget_escalates_cheap_to_strong() -> None:
    entry = QueueEntry(number=42, tier=Tier.CHEAP, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=entry,
        spent=0.5,
        ceiling=2.0,
        attempt_limit=3,
        attempts=1,
        gate_red=True,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    # Budget Leash decided to escalate ...
    assert outcome.decision is Decision.ESCALATE
    # ... modelled as the queue transition: re-enqueued one tier up, budget down.
    assert outcome.entry.tier is Tier.STRONG
    assert outcome.entry.state is QueueState.QUEUED
    assert outcome.entry.remaining_budget == 1


def test_escalation_carries_compacted_handoff() -> None:
    entry = QueueEntry(number=42, tier=Tier.CHEAP, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=entry,
        spent=0.5,
        ceiling=2.0,
        attempt_limit=3,
        attempts=1,
        gate_red=True,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
        exploration="Reading 200 files...\n" * 100,
    )
    handoff = outcome.handoff
    assert handoff is not None
    # AC2: the handoff preserves goal + attempt diff + exact gate error.
    assert GOAL in handoff.text
    assert "print(json.dumps(payload))" in handoff.text
    assert "acceptance-criteria not satisfied" in handoff.text
    # AC3: the redundant exploration is dropped.
    assert "Reading 200 files" not in handoff.text


def test_escalated_entry_runs_on_the_stronger_model_next() -> None:
    """End-to-end of the routing: a cheap-tier gate failure yields an entry whose
    next attempt is on the STRONG tier — the stronger model receives the handoff."""
    cheap_entry = QueueEntry(number=7, tier=Tier.CHEAP, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=cheap_entry,
        spent=0.2,
        ceiling=5.0,
        attempt_limit=3,
        attempts=1,
        gate_red=True,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    assert cheap_entry.tier is Tier.CHEAP  # original entry is unchanged (pure)
    assert outcome.entry.tier is Tier.STRONG
    assert outcome.handoff is not None


# ---------------------------------------------------------------------------
# AC4/AC5 — the Budget Leash bounds escalation; a hopeless issue stops-to-human
# ---------------------------------------------------------------------------

def test_budget_exhausted_stops_to_human_no_escalation() -> None:
    entry = QueueEntry(number=42, tier=Tier.CHEAP, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=entry,
        spent=2.0,
        ceiling=2.0,
        attempt_limit=3,
        attempts=1,
        gate_red=True,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    assert outcome.decision is Decision.STOP_TO_HUMAN
    assert outcome.entry.state is Terminal.ESCALATED_TO_HUMAN
    # No further attempt → no handoff is built.
    assert outcome.handoff is None


def test_strong_tier_still_red_stops_to_human() -> None:
    """Already on the strongest tier and still red: there is no tier above, so the
    Budget Leash hits its attempt limit / max tier and routes to human."""
    entry = QueueEntry(number=42, tier=Tier.STRONG, remaining_budget=1)
    outcome = escalate_on_failure(
        entry=entry,
        spent=0.5,
        ceiling=5.0,
        attempt_limit=3,
        attempts=3,  # at the attempt limit
        gate_red=True,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    assert outcome.decision is Decision.STOP_TO_HUMAN
    assert outcome.entry.state is Terminal.ESCALATED_TO_HUMAN
    assert outcome.handoff is None


def test_escalate_decision_but_no_tier_above_stops_to_human() -> None:
    """Defensive: if the Budget Leash says ESCALATE but the entry is already on the
    max tier (no tier above), the routing must not fabricate a tier — it routes to
    human instead, consistent with queue_state's max-tier hard stop."""
    entry = QueueEntry(number=42, tier=Tier.STRONG, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=entry,
        spent=0.5,
        ceiling=5.0,
        attempt_limit=3,
        attempts=1,
        gate_red=True,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    assert outcome.entry.state is Terminal.ESCALATED_TO_HUMAN
    assert outcome.handoff is None


# ---------------------------------------------------------------------------
# Reuse contract — the outcome type carries the decision + entry + handoff.
# ---------------------------------------------------------------------------

def test_outcome_type_shape() -> None:
    entry = QueueEntry(number=1, tier=Tier.CHEAP, remaining_budget=2)
    outcome = escalate_on_failure(
        entry=entry,
        spent=0.0,
        ceiling=2.0,
        attempt_limit=3,
        attempts=0,
        gate_red=False,
        goal=GOAL,
        attempt_diff=CHEAP_DIFF,
        gate_error=GATE_ERROR,
    )
    assert isinstance(outcome, EscalationOutcome)
    assert outcome.decision is Decision.CONTINUE
