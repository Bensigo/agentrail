"""Best-of-N selection policy — test-primary, critic-tiebreak (Finding 3).

WHY THIS MODULE EXISTS (the research that gates the design)
-----------------------------------------------------------
Issue #979 first shipped best-of-N as a *critic-ranked* attempt loop: it
early-stopped and picked the winner by the **critic's** accept/score alone. The
agent-flow research (CONTEXT.md "Agent-flow research 2026-06") is strong and
one-directional that this is the WRONG selector:

  * An LLM critic that only READS code (never runs it) waves through ~50% of
    *wrong* code.
  * Best-of-N with a critic-ONLY selector provably gets **worse** as N grows —
    generation drifts toward candidates that *fool the critic*, not candidates
    that are correct.

The SAFE version (this module) keeps the executable hidden-test gate as the
**PRIMARY** selector and demotes the cheap critic (#977) to a **SECONDARY
tie-breaker only**:

  1. PRIMARY = the executable hidden test (``run_objective_checks``). Early-stop
     on the FIRST candidate whose declared checks all pass. A test-passing
     candidate is always preferred over any test-failing one, *regardless* of
     critic opinion.
  2. SECONDARY = the cheap critic, used ONLY to break ties — to pick among
     *several test-passing* candidates, or to pick the least-bad candidate when
     the budget forces a stop before any candidate passed. A candidate the
     critic prefers but the TEST rejects is NEVER selected over a candidate the
     test accepts.

This module is **deep and pure**: it holds no I/O. The pipeline runs the
execute phase, the executable checks, and the critic phase (all I/O), then hands
this module the resulting :class:`Candidate` records and asks it to rank/select.
That keeps the policy deterministic and unit-testable with faithful fakes, and
keeps verify/critic a SEPARATE stage from execute (the second refuted finding:
do NOT merge verify into execute).

The selector is a strict total order via :func:`candidate_sort_key`:

    (test_passed, critic_score, -attempt)

``test_passed`` (the executable gate) dominates; ``critic_score`` (the cheap
critic) only ranks *within* an equal test-status bucket; ``-attempt`` is a
deterministic tiebreak that prefers the earliest candidate so the result is
stable. Because ``test_passed`` is the most-significant key, the critic can NEVER
lift a test-failing candidate above a test-passing one.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from agentrail.run.critic import CriticVerdict

# Finding 3: best-of-N with TEST-PRIMARY selection is gated behind this flag and
# is DEFAULT OFF (the env var is read via ``pipeline.layer_enabled``). When OFF,
# the pipeline keeps the pre-existing #979 critic-ranked loop, so merging this
# does NOT change the live autonomous loop. ``layer_enabled`` defaults a layer
# ON when its var is ABSENT, so a DEFAULT-OFF layer must read its OWN var with an
# absent-means-OFF rule — see ``pipeline.bestofn_testfirst_enabled``.
TESTFIRST_LAYER = "BESTOFN_TESTFIRST"


@dataclass(frozen=True)
class Candidate:
    """One best-of-N candidate and the two independent signals about it.

    ``attempt`` is the 1-based generation order. ``test_passed`` is the PRIMARY
    signal: did EVERY declared executable check (the hidden test) pass for this
    candidate? ``critic`` is the SECONDARY signal: the cheap critic's structured
    verdict (#977), used only as a tie-breaker. ``critic`` may be ``None`` when
    the critic phase was skipped/failed for this candidate — such a candidate is
    still a valid candidate (its test signal stands), it simply has the lowest
    possible critic score for tie-breaking.
    """

    attempt: int
    test_passed: bool
    critic: Optional[CriticVerdict] = None

    @property
    def critic_score(self) -> float:
        """The critic's [0, 1] confidence, or 0.0 when no critic verdict exists.

        Fail-closed: a missing critic verdict contributes the lowest possible
        tie-break score, so it can only ever LOSE a tie, never win one on absent
        evidence.
        """
        return self.critic.score if self.critic is not None else 0.0


def candidate_sort_key(candidate: Candidate) -> Tuple[int, float, int]:
    """The strict ranking key — test-PRIMARY, critic-SECONDARY, order-tiebreak.

    Returns ``(test_passed, critic_score, -attempt)``. Sorting candidates by this
    key (descending) puts the selected winner LAST in ascending order / FIRST in
    descending order:

      * ``int(test_passed)`` is the most-significant component, so EVERY
        test-passing candidate outranks EVERY test-failing one. The critic can
        never overturn the executable gate.
      * ``critic_score`` ranks only *within* an equal-test bucket (the secondary
        tie-breaker).
      * ``-attempt`` is a deterministic final tiebreak preferring the earliest
        candidate, so ties resolve stably.
    """
    return (int(candidate.test_passed), candidate.critic_score, -candidate.attempt)


def candidate_passes(candidate: Candidate) -> bool:
    """Did this candidate clear the PRIMARY (executable hidden-test) gate?

    The single early-stop signal: best-of-N stops generating the moment a
    candidate's declared checks all pass — the critic's opinion is irrelevant to
    *whether to stop*.
    """
    return candidate.test_passed


def select_best(candidates: Sequence[Candidate]) -> Optional[Candidate]:
    """Select the winning candidate: test-PRIMARY, critic-SECONDARY tiebreak.

    Pure. Returns the single best :class:`Candidate` or ``None`` when none were
    produced. Guarantees:

      * If ANY candidate passed the executable test, the winner is a
        test-passing candidate — a test-failing candidate is NEVER selected over
        a test-passing one, even if the critic preferred it.
      * Among multiple test-passing (or, if none passed, multiple test-failing)
        candidates, the higher critic score wins; the earliest attempt breaks a
        remaining tie.
    """
    if not candidates:
        return None
    return max(candidates, key=candidate_sort_key)


def would_exceed_budget(
    cumulative_cost_usd: float,
    budget_usd: float,
    *,
    next_attempt_estimate_usd: float = 0.0,
) -> bool:
    """Should best-of-N STOP before spawning another candidate (budget-aware)?

    Pure budget guard so the extra best-of-N attempts respect the per-issue
    budget cap (the loop must never blow the cap to chase one more candidate).
    Returns ``True`` — meaning "stop, do not spawn the next candidate" — when:

      * a positive ``budget_usd`` cap is set AND
      * the spend already AT or OVER the cap, or the conservative estimate of the
        next attempt would push it over.

    A non-positive ``budget_usd`` means "no cap" → always ``False`` (never blocks),
    matching the pipeline's existing convention where ``budget_usd <= 0`` disables
    the budget guardrail.
    """
    if budget_usd <= 0:
        return False
    projected = cumulative_cost_usd + max(0.0, next_attempt_estimate_usd)
    return projected >= budget_usd


def stop_reason(
    selected: Optional[Candidate],
    attempts_run: int,
    n: int,
    *,
    budget_hit: bool = False,
) -> str:
    """Human-readable reason best-of-N stopped (for the run record / logs).

    Pure. Precedence: a budget stop is reported first (it is the safety stop),
    then an early test-pass, then exhausting N. This string is observational —
    it never changes done-ness (the Objective Gate decides that).
    """
    if budget_hit:
        return (
            f"best-of-n stopped: budget cap reached after {attempts_run} "
            f"candidate(s) (of N={n})"
        )
    if selected is not None and selected.test_passed:
        return (
            f"best-of-n stopped early: candidate {selected.attempt} passed the "
            f"executable test (of N={n})"
        )
    return f"best-of-n exhausted N={n} candidates; none passed the executable test"


__all__ = [
    "Candidate",
    "candidate_sort_key",
    "candidate_passes",
    "select_best",
    "would_exceed_budget",
    "stop_reason",
]
