"""Tests for agentrail/run/budget_leash.py — the deep, pure Budget Leash.

The Budget Leash is the hard backstop that bounds spend per issue (CONTEXT.md,
ADR 0011): a per-issue cost ceiling plus an escalation-attempt limit. Given the
current spend, attempts so far, the ceiling, the attempt limit, and whether the
last attempt failed the Objective Gate, it returns exactly one decision:

- **continue** — under budget, gate not red → keep going on the current tier;
- **escalate** — gate failed WITH budget remaining → re-attempt at a higher tier;
- **stop-to-human** — budget exhausted OR the escalation-attempt limit is hit →
  route to escalated-to-human (never an infinite retry).

These are behavior-only unit tests over plain inputs — the leash is pure, so it
takes already-computed spend/attempts and returns a verdict. Reading the real
spend is the caller's job (thin orchestration).
"""
from __future__ import annotations

from agentrail.run.budget_leash import DEFAULT_PER_ISSUE_BUDGET_USD, Decision, check


# ---------------------------------------------------------------------------
# AC1 — under budget → continue
# ---------------------------------------------------------------------------

def test_under_budget_no_gate_failure_continues() -> None:
    decision = check(
        spent=0.5, attempts=1, ceiling=2.0, attempt_limit=3, gate_red=False
    )
    assert decision is Decision.CONTINUE


def test_well_under_budget_first_attempt_continues() -> None:
    decision = check(
        spent=0.0, attempts=0, ceiling=5.0, attempt_limit=3, gate_red=False
    )
    assert decision is Decision.CONTINUE


# ---------------------------------------------------------------------------
# AC2 — gate-fail with budget remaining → escalate
# ---------------------------------------------------------------------------

def test_gate_red_with_budget_and_attempts_remaining_escalates() -> None:
    decision = check(
        spent=0.5, attempts=1, ceiling=2.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.ESCALATE


def test_gate_red_just_under_ceiling_escalates() -> None:
    decision = check(
        spent=1.99, attempts=1, ceiling=2.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.ESCALATE


# ---------------------------------------------------------------------------
# AC3 — budget exhausted OR attempt-limit hit → stop-to-human (never infinite)
# ---------------------------------------------------------------------------

def test_budget_exhausted_stops_to_human_even_on_gate_red() -> None:
    decision = check(
        spent=2.0, attempts=1, ceiling=2.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.STOP_TO_HUMAN


def test_spend_over_ceiling_stops_to_human() -> None:
    decision = check(
        spent=2.5, attempts=1, ceiling=2.0, attempt_limit=3, gate_red=False
    )
    assert decision is Decision.STOP_TO_HUMAN


def test_attempt_limit_hit_stops_to_human_even_with_budget() -> None:
    decision = check(
        spent=0.1, attempts=3, ceiling=2.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.STOP_TO_HUMAN


def test_budget_exhausted_takes_precedence_over_continue() -> None:
    # Even with gate not red, exhausted budget is a hard stop.
    decision = check(
        spent=2.0, attempts=1, ceiling=2.0, attempt_limit=3, gate_red=False
    )
    assert decision is Decision.STOP_TO_HUMAN


# ---------------------------------------------------------------------------
# Attempt-limit boundary (off-by-one): exactly at limit vs one below
# ---------------------------------------------------------------------------

def test_one_attempt_below_limit_with_gate_red_escalates() -> None:
    # attempts=2, limit=3 → one re-attempt still allowed.
    decision = check(
        spent=0.1, attempts=2, ceiling=2.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.ESCALATE


def test_exactly_at_attempt_limit_stops_to_human() -> None:
    # attempts=3, limit=3 → no re-attempt allowed; stop.
    decision = check(
        spent=0.1, attempts=3, ceiling=2.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.STOP_TO_HUMAN


def test_one_attempt_below_limit_no_gate_red_continues() -> None:
    decision = check(
        spent=0.1, attempts=2, ceiling=2.0, attempt_limit=3, gate_red=False
    )
    assert decision is Decision.CONTINUE


# ---------------------------------------------------------------------------
# Zero/absent ceiling = uncapped (consistent with the run budget guardrail,
# where budget_usd=0 means unlimited).
# ---------------------------------------------------------------------------

def test_zero_ceiling_is_uncapped_continues() -> None:
    decision = check(
        spent=999.0, attempts=1, ceiling=0.0, attempt_limit=3, gate_red=False
    )
    assert decision is Decision.CONTINUE


def test_zero_ceiling_still_honours_attempt_limit() -> None:
    # An uncapped ceiling must NOT defeat the attempt limit — otherwise the loop
    # could retry forever.
    decision = check(
        spent=999.0, attempts=3, ceiling=0.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.STOP_TO_HUMAN


def test_zero_ceiling_gate_red_under_attempt_limit_escalates() -> None:
    decision = check(
        spent=999.0, attempts=1, ceiling=0.0, attempt_limit=3, gate_red=True
    )
    assert decision is Decision.ESCALATE


# ---------------------------------------------------------------------------
# Termination: from any state, repeatedly applying the leash reaches
# stop-to-human in bounded steps (never an infinite retry).
# ---------------------------------------------------------------------------

def test_escalation_terminates_in_bounded_steps() -> None:
    attempt_limit = 5
    attempts = 0
    decisions: list[Decision] = []
    # Worst case: gate keeps failing and spend never reaches the ceiling. The
    # attempt counter monotonically increases, so the limit is hit in bounded
    # steps and the leash must eventually stop-to-human.
    for _ in range(attempt_limit + 10):
        d = check(
            spent=0.0,
            attempts=attempts,
            ceiling=100.0,
            attempt_limit=attempt_limit,
            gate_red=True,
        )
        decisions.append(d)
        if d is Decision.STOP_TO_HUMAN:
            break
        attempts += 1  # an attempt was consumed; counter only ever increases
    assert decisions[-1] is Decision.STOP_TO_HUMAN
    # It stopped no later than the attempt limit — not after the +10 slack.
    assert len(decisions) <= attempt_limit + 1


# ---------------------------------------------------------------------------
# Input validation — guard against misuse that could mask an infinite retry.
# ---------------------------------------------------------------------------

def test_negative_attempt_limit_is_rejected() -> None:
    import pytest

    with pytest.raises(ValueError):
        check(spent=0.0, attempts=0, ceiling=2.0, attempt_limit=0, gate_red=False)


def test_negative_spend_is_rejected() -> None:
    import pytest

    with pytest.raises(ValueError):
        check(spent=-1.0, attempts=0, ceiling=2.0, attempt_limit=3, gate_red=False)


# ---------------------------------------------------------------------------
# Product default (issue #1269 PR 1): the constant the product path (CLI
# `effective_budget`) falls back to when NEITHER an explicit flag NOR
# .agentrail/config.json's budgets.per_issue_usd says anything at all.
# ---------------------------------------------------------------------------

def test_default_per_issue_budget_usd_is_three_dollars() -> None:
    assert DEFAULT_PER_ISSUE_BUDGET_USD == 3.0


def test_default_per_issue_budget_usd_actually_caps_via_check() -> None:
    # Sanity: the constant is a real, positive ceiling as far as `check` is
    # concerned — spend at/over it stops, under it continues.
    assert check(spent=DEFAULT_PER_ISSUE_BUDGET_USD, attempts=0,
                 ceiling=DEFAULT_PER_ISSUE_BUDGET_USD, attempt_limit=1,
                 gate_red=False) is Decision.STOP_TO_HUMAN
    assert check(spent=DEFAULT_PER_ISSUE_BUDGET_USD - 0.01, attempts=0,
                 ceiling=DEFAULT_PER_ISSUE_BUDGET_USD, attempt_limit=1,
                 gate_red=False) is Decision.CONTINUE
