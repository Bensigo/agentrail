"""Budget Leash — the deep, pure per-issue spend backstop (ADR 0011, M036).

CONTEXT.md, **Budget Leash**: the hard backstop that bounds spend per issue — a
per-issue cost *ceiling* plus an *escalation-attempt limit*. The cheap model
fails → escalate (compacted handoff) → if the strong model still cannot reach
green within the remaining budget, stop and route to **Escalated-to-human**.
This is what makes the loop safe to leave unattended.

This module is a **deep module** (verification-contract-architecture.md): pure
logic, no I/O, deterministic, unit-tested in isolation. It is the *policy*
that, given already-computed facts about a run, returns one decision:

- :attr:`Decision.CONTINUE` — under budget, the last attempt did not fail the
  Objective Gate → keep going on the current tier (AC1);
- :attr:`Decision.ESCALATE` — the gate failed WITH budget and an attempt
  remaining → re-attempt at a higher tier (AC2; modelled as the **Issue Queue**
  GATE_RED transition in ``agentrail/afk/queue_state.py``);
- :attr:`Decision.STOP_TO_HUMAN` — the per-issue budget is exhausted OR the
  escalation-attempt limit is hit → route to the **Escalated-to-human** terminal
  (AC3). NEVER an infinite retry.

It does NOT read the actual spend, mutate a queue entry, or pick a model — those
are the caller's job (thin orchestration). It is complementary to
``queue_state.transition``: ``queue_state`` is the entry lifecycle; this leash is
the decision the orchestrator (or that state machine) consults.

Termination guarantee (AC3): ``attempts`` is a non-negative integer that the
caller only ever *increases* between calls, ``attempt_limit`` is a fixed positive
integer, and ``spent`` only ever increases while ``ceiling`` is fixed. Once
``attempts >= attempt_limit`` (reached in at most ``attempt_limit`` steps) the
leash returns :attr:`Decision.STOP_TO_HUMAN` regardless of any other input, so no
sequence of decisions can escalate forever. A capped ceiling stops even sooner.
"""
from __future__ import annotations

from enum import Enum

# Product default per-issue spend ceiling in dollars (issue #1269, PR ①).
#
# Applies ONLY when neither an explicit --budget-usd/--budget-per-issue flag
# NOR `.agentrail/config.json`'s `budgets.per_issue_usd` sets a value at all —
# see `agentrail.cli.commands.run.effective_budget`, the single resolution
# site both `agentrail run` and `agentrail afk` funnel through
# (`resolve_default_budget` is the shared fallback both call). An explicit
# ``0`` at either of those tiers still means deliberately uncapped; this
# constant only fills the gap when NEITHER tier says anything at all — before
# this, the product default was silently 0.0 (uncapped), which defeated the
# whole point of the Budget Leash on the one path real runs actually take.
#
# WHY $3, and why flat: this is an ESTIMATE-ABSENT CHECK-IN THRESHOLD, not the
# product's real per-task budget. The estimate IS the budget — Jace's
# alignment brief prices each task (task-type-aware, shown to the user,
# overridable — issues #1274/#1275) and that number arrives through the
# flag/config tiers above, which always win over this constant. This constant
# only ever fires when NO estimate reached the run at all, and it is tight ON
# PURPOSE for a price-sensitive product: a silent runaway burns real money, so
# an un-estimated task checks in at $3 rather than being trusted to self-limit.
#
# That check-in is RESUMABLE, never a kill: hitting it does not fail the
# issue or discard any work — it pauses with a visible reason (blockedReason +
# phase marker) and picks back up the moment a real budget is supplied (a
# bigger --budget-usd/--budget-per-issue, a configured budgets.per_issue_usd,
# or a future alignment-brief estimate). A huge task with no estimate is
# expected to hit this and check in; that is the design working, not a
# failure mode — never describe or message it as a hard death (owner call,
# 2026-07-18: $10 was judged too generous a silent runway for an
# un-estimated run).
DEFAULT_PER_ISSUE_BUDGET_USD = 3.0


class Decision(str, Enum):
    """The single decision the Budget Leash returns. Vocabulary from CONTEXT.md."""

    CONTINUE = "continue"            # under budget → keep going on the current tier
    ESCALATE = "escalate"            # gate-fail with room → re-attempt a tier up
    STOP_TO_HUMAN = "stop-to-human"  # exhausted/limit-hit → escalated-to-human


def check(
    *,
    spent: float,
    attempts: int,
    ceiling: float,
    attempt_limit: int,
    gate_red: bool,
) -> Decision:
    """Return the Budget Leash decision for a run. Pure; no I/O.

    Args:
        spent: Dollars spent on this issue so far (>= 0).
        attempts: Attempts already consumed on this issue (>= 0). The caller
            increments this between calls; it never decreases.
        ceiling: Per-issue cost ceiling in dollars. ``0`` (or less) means
            *uncapped* — consistent with the run budget guardrail where
            ``budget_usd=0`` is unlimited. An uncapped ceiling never defeats the
            attempt limit.
        attempt_limit: Maximum number of attempts (initial + escalations) before
            a hard stop. Must be >= 1.
        gate_red: Whether the most recent attempt failed the Objective Gate.

    Returns:
        :attr:`Decision.STOP_TO_HUMAN` when the budget is exhausted
        (``spent >= ceiling`` with a positive ceiling) OR the attempt limit is
        hit (``attempts >= attempt_limit``); else :attr:`Decision.ESCALATE` when
        ``gate_red``; else :attr:`Decision.CONTINUE`.

    Raises:
        ValueError: if ``attempt_limit < 1`` or ``spent < 0`` — misuse that could
            otherwise mask an infinite retry.
    """
    if attempt_limit < 1:
        raise ValueError(f"attempt_limit must be >= 1, got {attempt_limit}")
    if spent < 0:
        raise ValueError(f"spent must be >= 0, got {spent}")

    # AC3: hard stops first — these dominate every other consideration so the
    # loop can never retry past its bounds. The attempt-limit check is what
    # guarantees termination even when the ceiling is uncapped.
    budget_exhausted = ceiling > 0 and spent >= ceiling
    attempt_limit_hit = attempts >= attempt_limit
    if budget_exhausted or attempt_limit_hit:
        return Decision.STOP_TO_HUMAN

    # AC2: a gate failure with budget and an attempt still remaining escalates
    # (re-attempt one tier up).
    if gate_red:
        return Decision.ESCALATE

    # AC1: under budget, gate not red → continue on the current tier.
    return Decision.CONTINUE
