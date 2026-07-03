"""Statistically honest regression gate over eval reports (issue #1040, PRD4).

The eval loop's last brake. It reads the SAME hygiene-clean repetition records
the reporter aggregates (``corpus -> runner -> scorer -> N reps -> reporter``)
and decides whether a *candidate* arm regressed against a *baseline* arm on the
two headline axes CONTEXT.md names falsifiable:

- **solve-rate** (hidden-test pass fraction), and
- **$/solved** — Cost-per-Issue-to-Green, the headline cost axis.

Why the naive design is wrong
------------------------------
The originally-planned gate ("fail if solve-rate drops >5pp") FIRES ON PURE
NOISE. At 30 reps the aggregate solve-rate 95% CI is roughly +/-16pp; a single
tie task flipping 33%<->67% between reps moves the aggregate ~3.3pp and
$/solved ~12%. A point threshold on a point estimate cannot tell that jitter
apart from a real regression, so it either red-flags healthy no-change runs
(a flaky gate is an ignored gate) or is set so loose it never catches anything.

The honest design (this module)
-------------------------------
1. **Paired, per-task.** Both arms run the SAME tasks, so we pair by task and
   test the *per-task delta* (candidate minus baseline). Pairing removes the
   between-task variance that dominates the aggregate CI — a task that is hard
   in both arms contributes ~0 to the delta instead of inflating the spread.
2. **Confidence intervals, not point thresholds.** A metric is a regression
   only when its two-sided 95% CI on the mean paired delta EXCLUDES ZERO *and*
   the point effect EXCEEDS a stated materiality threshold. "CI excludes zero"
   rules out noise; "exceeds materiality" rules out real-but-trivial drifts.
   Applied to BOTH solve-rate and $/solved (the $/solved leg is PRD2's cost
   non-regression check).
3. **Explicit tie-task handling.** Tasks that tie (delta 0) are KEPT as paired
   zeros. They are the honest signal that the arms agree on that task; dropping
   them would bias the mean, and inflating reps to "resolve" ties is exactly the
   budget waste the PRD warns against. Ties pull the mean toward zero and are
   disclosed in the report.
4. **Statistical power, reported.** An under-powered comparison returns an
   explicit ``INSUFFICIENT_REPS`` verdict — NEVER a confident green or red. The
   achieved power (against the materiality effect size) is on the report so a
   green is trustworthy rather than merely "not yet red".
5. **Hygiene first.** ``<synthetic>`` ECONNRESET fallback reps
   (``RepetitionRecord.network_artifact``, issue #1033) are EXCLUDED before any
   aggregation. Their solved=0 / $0 is a network artifact, not a score; folding
   them in would fabricate regressions out of dropped connections.

Purity: this module is pure given its inputs (no IO, no subprocess, no network,
no RNG). Every number is a deterministic function of the records, so the gate's
own tests are airtight and it can never flake on a random seed.

Stats note: with no scipy/numpy in the tree, the Student-t critical value and
the noncentral-t power are computed from stdlib ``math`` via well-known series.
The gate is intentionally conservative — when in doubt it prefers
``INSUFFICIENT_REPS`` over a confident verdict.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Sequence, Tuple

from agentrail.evals.pricing_adapter import usage_cost
from agentrail.evals.reporter import RepetitionRecord


# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------

class GateVerdict(str, Enum):
    """The three — and only three — outcomes of a regression comparison.

    ``INSUFFICIENT_REPS`` is a first-class state, DISTINCT from GREEN and RED:
    an under-powered comparison has *no confident answer*, and pretending it is
    green (silent pass) or red (flaky block) is the exact failure this gate
    exists to avoid.
    """

    GREEN = "green"                       # no material regression detected
    RED = "red"                           # a material regression, CI excludes 0
    INSUFFICIENT_REPS = "insufficient_reps"  # under-powered — no confident call


# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class GateThresholds:
    """The gate's materiality and power knobs — all explicit, none hidden.

    Defaults are the PRD's honest floor, not tuned to pass anything:

    - ``solve_rate_materiality`` — a per-task mean solve-rate DROP smaller than
      this (5pp) is not worth blocking on even if statistically real.
    - ``dollars_per_solved_materiality_frac`` — a $/solved INCREASE smaller than
      this fraction (15%) of the baseline is not material. Relative, because a
      cheap corpus and an expensive one should not share an absolute $ floor.
    - ``confidence`` — two-sided CI level (0.95 => 95% CI, alpha 0.05).
    - ``min_paired_tasks`` — fewer paired tasks than this can never be confident
      (a paired t-test on 2 points is meaningless); forces INSUFFICIENT_REPS.
    - ``min_reps_per_task`` — a task with fewer reps than this in either arm is
      too jittery to pair; it is dropped from the paired set (and disclosed).
    - ``min_power`` — required achieved power against the materiality effect. A
      green with power below this is downgraded to INSUFFICIENT_REPS: we cannot
      distinguish "no regression" from "not enough data to see one".
    """

    solve_rate_materiality: float = 0.05
    dollars_per_solved_materiality_frac: float = 0.15
    confidence: float = 0.95
    min_paired_tasks: int = 3
    min_reps_per_task: int = 2
    min_power: float = 0.80


# ---------------------------------------------------------------------------
# Per-task paired deltas (the transparency payload AC3 requires)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PairedTaskDelta:
    """One task's paired (candidate - baseline) deltas — the atomic unit.

    Carried on the report so a verdict is auditable per task, not just a scalar:
    which tasks moved, which tied, which arm won each.

    - ``solve_rate_delta`` — candidate minus baseline per-task solve fraction.
      Always defined (both arms ran the task with >= min reps).
    - ``dollars_per_solved_delta`` — candidate minus baseline per-task $/solved.
      ``None`` when either arm never solved the task (no defined $/solved to
      difference) — DISTINCT from a real 0.0 delta.
    - ``is_tie`` — the arms produced the same per-task solve fraction. Kept in
      the paired set as an honest zero (see module docstring), flagged for the
      report's tie disclosure.
    - ``paired_reps`` — the MINIMUM real-rep count across the two arms for this
      task. Drives the sampling-noise floor in the power calc: a per-task solve
      fraction over few reps is coarse, so few reps => low resolvable power, no
      matter how tidy the observed deltas happen to look.
    """

    task: str
    baseline_solve_rate: float
    candidate_solve_rate: float
    solve_rate_delta: float
    baseline_dollars_per_solved: Optional[float]
    candidate_dollars_per_solved: Optional[float]
    dollars_per_solved_delta: Optional[float]
    is_tie: bool
    paired_reps: int


# ---------------------------------------------------------------------------
# Per-metric statistical leg
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class MetricGateResult:
    """The paired-test result for ONE axis (solve-rate or $/solved).

    Everything AC3 asks a gate to disclose "not just a point estimate and a
    verdict": the paired mean, its CI, the effect vs materiality, the sample
    size actually used, and the achieved power.

    - ``mean_delta`` — mean per-task paired delta (candidate - baseline). For
      solve-rate, negative = regression (candidate solves less). For $/solved,
      positive = regression (candidate costs more per solve).
    - ``ci_low`` / ``ci_high`` — two-sided CI on ``mean_delta`` at the gate's
      confidence. ``ci_excludes_zero`` is the noise test.
    - ``materiality`` — the effect magnitude that must be exceeded (absolute for
      solve-rate; baseline-relative dollars for $/solved).
    - ``n`` — paired tasks actually used for THIS metric (the $/solved leg often
      has fewer, since a task must solve in both arms to have a defined ratio).
    - ``achieved_power`` — power to detect a true effect of size ``materiality``
      given ``n`` and the observed paired stddev, at the gate's alpha. Below the
      threshold => the comparison is under-powered for this metric.
    - ``regressed`` — the leg's own red flag: CI excludes zero in the HARMFUL
      direction AND |effect| >= materiality. The overall verdict ORs the legs.
    """

    metric: str
    mean_delta: float
    ci_low: float
    ci_high: float
    ci_excludes_zero: bool
    materiality: float
    exceeds_materiality: bool
    n: int
    stddev: float
    achieved_power: float
    underpowered: bool
    regressed: bool


# ---------------------------------------------------------------------------
# Full gate report
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RegressionGateReport:
    """The complete, auditable output of one baseline-vs-candidate comparison.

    A verdict alone is not falsifiable; this carries the evidence (AC3): every
    per-task paired delta, each metric leg's CI and power, the tie and dropped
    counts, and the excluded network-artifact count so a reader can re-derive
    the call by hand.
    """

    baseline_arm: str
    candidate_arm: str
    verdict: GateVerdict
    solve_rate: MetricGateResult
    dollars_per_solved: MetricGateResult
    per_task_deltas: List[PairedTaskDelta]
    thresholds: GateThresholds
    tie_task_count: int
    dropped_task_count: int
    network_artifact_count: int
    reasons: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Statistics — self-contained, deterministic, stdlib only.
# ---------------------------------------------------------------------------

def _student_t_critical(df: int, confidence: float) -> float:
    """Two-sided Student-t critical value t*(df, confidence), stdlib only.

    Inverts the t CDF by bisection on the closed-form CDF built from the
    regularized incomplete beta function. Deterministic and monotone, so the
    same (df, confidence) always yields the same value — the gate never flakes.
    For df large it converges to the normal z; for small df it is wider (fatter
    tails), which is exactly the conservatism a small paired set needs.
    """
    if df <= 0:
        return float("inf")
    alpha = 1.0 - confidence
    target = 1.0 - alpha / 2.0  # one-sided upper tail prob for two-sided CI

    lo, hi = 0.0, 1000.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if _student_t_cdf(mid, df) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def _student_t_cdf(t: float, df: int) -> float:
    """CDF of Student-t with ``df`` degrees of freedom at ``t`` (stdlib only)."""
    x = df / (df + t * t)
    ib = _reg_incomplete_beta(df / 2.0, 0.5, x)
    if t >= 0.0:
        return 1.0 - 0.5 * ib
    return 0.5 * ib


def _reg_incomplete_beta(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta I_x(a, b) via a Lentz continued fraction.

    Numerical Recipes' ``betai``: accurate and branch-stable for the (a, b)
    ranges we hit (a = df/2, b = 1/2). Used by the t CDF above.
    """
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    front = math.exp(lbeta + a * math.log(x) + b * math.log(1.0 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for the incomplete beta (Lentz's method)."""
    tiny = 1e-30
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    h = d
    for m in range(1, 200):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-12:
            break
    return h


def _normal_cdf(z: float) -> float:
    """Standard-normal CDF via the error function (stdlib ``math.erf``)."""
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _paired_power(
    *, n: int, effect: float, stddev: float, stddev_floor: float, confidence: float
) -> float:
    """Achieved power of a two-sided paired t-test, normal-approximated.

    Power to reject H0 (mean delta = 0) when the true mean delta equals
    ``effect`` and the per-task paired stddev is ``stddev``, at ``n`` pairs and
    the gate's alpha. Uses the standard normal approximation to the noncentral-t
    (adequate and conservative for the small-n regime the gate lives in; it does
    not overstate power).

    ``stddev_floor`` is the irreducible sampling noise of a per-task metric given
    how many reps produced it (a solve fraction over 2 reps is coarse — steps of
    0.5 — so its true jitter is large even if THIS sample happened to tie). The
    calc uses ``max(observed_stddev, stddev_floor)`` so a lucky zero-variance
    small sample cannot fake infinite power; power then honestly reflects rep
    adequacy and an under-repped comparison reads as under-powered.

    Degenerate guards keep it deterministic:
    - ``n < 2`` — cannot estimate variance => power 0.0 (forces underpowered).
    - a zero ``effect`` => 0.0 (nothing to detect).
    - both ``stddev`` and the floor zero with a nonzero effect — any real
      separation is perfectly detectable => power 1.0.
    """
    if n < 2 or effect == 0.0:
        return 0.0
    sd = max(stddev, stddev_floor)
    if sd <= 0.0:
        return 1.0
    alpha = 1.0 - confidence
    # z critical for two-sided alpha.
    z_alpha = _inv_normal_cdf(1.0 - alpha / 2.0)
    ncp = abs(effect) / (sd / math.sqrt(n))  # noncentrality
    # P(reject) ~= Phi(ncp - z_alpha) + Phi(-ncp - z_alpha); second term ~0.
    return _normal_cdf(ncp - z_alpha) + _normal_cdf(-ncp - z_alpha)


def _inv_normal_cdf(p: float) -> float:
    """Inverse standard-normal CDF (Acklam's rational approximation)."""
    if p <= 0.0:
        return float("-inf")
    if p >= 1.0:
        return float("inf")
    # Coefficients for Acklam's algorithm.
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow = 0.02425
    phigh = 1.0 - plow
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
    if p <= phigh:
        q = p - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
               (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
    q = math.sqrt(-2.0 * math.log(1.0 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)


# ---------------------------------------------------------------------------
# Per-task aggregation from raw reps (hygiene applied here)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _ArmTaskStats:
    """A single arm's per-task real-rep stats (network artifacts already gone)."""

    reps: int
    solved: int
    total_cost: float

    @property
    def solve_rate(self) -> float:
        return self.solved / self.reps if self.reps else 0.0

    @property
    def dollars_per_solved(self) -> Optional[float]:
        # Undefined when the task never solved in this arm (never divide by 0).
        return (self.total_cost / self.solved) if self.solved else None


def _per_task_stats(
    records: Sequence[RepetitionRecord],
) -> Tuple[Dict[str, _ArmTaskStats], int]:
    """Fold an arm's reps into per-task stats, EXCLUDING network artifacts.

    Returns (task -> stats, network_artifact_count). Hygiene (issue #1033) is
    applied HERE, once, before pairing: a ``<synthetic>`` ECONNRESET fallback
    rep contributes to no metric — its solved=0/$0 is a network artifact — and
    is only counted for disclosure. This mirrors the reporter's own partition so
    the gate reads exactly the numbers the report shows.
    """
    artifacts = 0
    reps: Dict[str, int] = defaultdict(int)
    solved: Dict[str, int] = defaultdict(int)
    cost: Dict[str, float] = defaultdict(float)
    for r in records:
        if r.network_artifact:
            artifacts += 1
            continue
        reps[r.task] += 1
        if r.solved:
            solved[r.task] += 1
        cost[r.task] += usage_cost(r.usage)
    stats = {
        task: _ArmTaskStats(reps=reps[task], solved=solved[task], total_cost=cost[task])
        for task in reps
    }
    return stats, artifacts


# ---------------------------------------------------------------------------
# The metric legs
# ---------------------------------------------------------------------------

def _solve_rate_leg(
    deltas: Sequence[PairedTaskDelta], thresholds: GateThresholds
) -> MetricGateResult:
    """Paired-t leg for solve-rate. Regression = candidate solves LESS.

    Each per-task solve fraction is a mean of Bernoulli reps, so it carries
    irreducible sampling noise: variance ``p(1-p)/r`` at fraction ``p`` over
    ``r`` reps. A paired per-task delta sums the two arms' variances; the
    representative stddev floor is the RMS of those per-task delta stddevs. It is
    computed from the OBSERVED fractions (not a blanket worst-case 0.5), so a
    corpus of clean 0/5 and 5/5 tasks — genuinely low-noise — is not
    pessimistically penalised, while a corpus of jittery mid-range tasks over
    few reps correctly reads as under-powered. Zero when every task is saturated
    (all fractions 0 or 1) and reps are plentiful — nothing left to resolve.
    """
    diffs = [d.solve_rate_delta for d in deltas]
    per_task_var = []
    for d in deltas:
        r = d.paired_reps
        if r <= 0:
            continue
        pb, pc = d.baseline_solve_rate, d.candidate_solve_rate
        per_task_var.append(pb * (1.0 - pb) / r + pc * (1.0 - pc) / r)
    if per_task_var:
        stddev_floor = math.sqrt(statistics.fmean(per_task_var))
    else:
        stddev_floor = 0.0
    return _leg_from_diffs(
        metric="solve_rate",
        diffs=diffs,
        materiality=thresholds.solve_rate_materiality,
        harmful_sign=-1,  # a NEGATIVE mean delta is harmful (fewer solves)
        stddev_floor=stddev_floor,
        thresholds=thresholds,
    )


def _dollars_leg(
    deltas: Sequence[PairedTaskDelta],
    baseline_arm_dps: Optional[float],
    thresholds: GateThresholds,
) -> MetricGateResult:
    """Paired-t leg for $/solved. Regression = candidate costs MORE per solve.

    Only tasks with a DEFINED per-task $/solved in both arms contribute (a ratio
    needs a solve in each arm). Materiality is baseline-relative: X% of the
    baseline arm's overall $/solved, so the absolute $ floor scales with how
    expensive the corpus is. When the baseline arm has no defined $/solved (it
    solved nothing), materiality is undefined and the leg cannot fire.
    """
    diffs = [
        d.dollars_per_solved_delta
        for d in deltas
        if d.dollars_per_solved_delta is not None
    ]
    if baseline_arm_dps is None or baseline_arm_dps <= 0.0:
        materiality = float("inf")  # no meaningful relative floor => cannot fire
    else:
        materiality = thresholds.dollars_per_solved_materiality_frac * baseline_arm_dps
    return _leg_from_diffs(
        metric="dollars_per_solved",
        diffs=diffs,
        materiality=materiality,
        harmful_sign=+1,  # a POSITIVE mean delta is harmful (more $ per solve)
        # $/solved is unbounded (not a fraction), so there is no closed-form
        # Bernoulli noise floor; power rests on the observed paired stddev alone.
        stddev_floor=0.0,
        thresholds=thresholds,
    )


def _leg_from_diffs(
    *,
    metric: str,
    diffs: Sequence[float],
    materiality: float,
    harmful_sign: int,
    stddev_floor: float,
    thresholds: GateThresholds,
) -> MetricGateResult:
    """Build one metric leg from its vector of paired per-task diffs.

    Computes the paired mean, the two-sided CI (Student-t), whether the CI
    excludes zero, whether the effect exceeds materiality in the harmful
    direction, and the achieved power vs the materiality effect size. The leg's
    ``regressed`` flag is CI-excludes-zero AND harmful-and-material — the two
    conditions the PRD requires together, so noise alone never trips it.
    """
    n = len(diffs)
    if n < 2:
        # Cannot estimate variance — no CI, no power. Non-regressing, but the
        # caller downgrades the overall verdict to INSUFFICIENT_REPS on n.
        mean = statistics.fmean(diffs) if diffs else 0.0
        return MetricGateResult(
            metric=metric, mean_delta=mean, ci_low=mean, ci_high=mean,
            ci_excludes_zero=False, materiality=materiality,
            exceeds_materiality=False, n=n, stddev=0.0,
            achieved_power=0.0, underpowered=True, regressed=False,
        )

    mean = statistics.fmean(diffs)
    stddev = statistics.stdev(diffs)  # sample stddev (n-1)
    sem = stddev / math.sqrt(n)
    tcrit = _student_t_critical(n - 1, thresholds.confidence)
    half = tcrit * sem
    ci_low, ci_high = mean - half, mean + half
    ci_excludes_zero = (ci_low > 0.0) or (ci_high < 0.0)

    harmful_effect = harmful_sign * mean  # >0 when the mean moved the bad way
    exceeds_materiality = harmful_effect >= materiality

    # A regression is harmful CI excludes zero (the harmful bound is past 0) AND
    # the effect is material. "CI excludes zero" alone can be a tiny-but-real
    # drift; materiality gates that out.
    ci_excludes_zero_harmful = (
        (harmful_sign < 0 and ci_high < 0.0) or (harmful_sign > 0 and ci_low > 0.0)
    )
    regressed = ci_excludes_zero_harmful and exceeds_materiality

    power = _paired_power(
        n=n, effect=materiality if math.isfinite(materiality) else 0.0,
        stddev=stddev, stddev_floor=stddev_floor,
        confidence=thresholds.confidence,
    )
    underpowered = power < thresholds.min_power

    return MetricGateResult(
        metric=metric, mean_delta=mean, ci_low=ci_low, ci_high=ci_high,
        ci_excludes_zero=ci_excludes_zero, materiality=materiality,
        exceeds_materiality=exceeds_materiality, n=n, stddev=stddev,
        achieved_power=power, underpowered=underpowered, regressed=regressed,
    )


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------

def evaluate_regression(
    records: Sequence[RepetitionRecord],
    *,
    baseline_arm: str,
    candidate_arm: str,
    thresholds: Optional[GateThresholds] = None,
) -> RegressionGateReport:
    """Compare ``candidate_arm`` against ``baseline_arm`` — the regression gate.

    ``records`` are the raw repetition records for BOTH arms (the reporter's own
    input). The gate:

    1. drops ``<synthetic>`` network-artifact reps (issue #1033),
    2. pairs by task (only tasks present in both arms with >= ``min_reps_per_task``
       reps in each — others are dropped and disclosed),
    3. runs a paired-t leg on solve-rate and on $/solved,
    4. returns RED iff EITHER leg regressed (harmful CI excludes zero AND
       exceeds materiality), INSUFFICIENT_REPS iff the comparison is
       under-powered / too few paired tasks, else GREEN.

    Fail-closed: too little data is never silently GREEN. The three states are
    disjoint and every one carries its evidence (AC3/AC4).
    """
    thresholds = thresholds or GateThresholds()

    base_stats, base_artifacts = _per_task_stats(
        [r for r in records if r.arm == baseline_arm]
    )
    cand_stats, cand_artifacts = _per_task_stats(
        [r for r in records if r.arm == candidate_arm]
    )
    network_artifact_count = base_artifacts + cand_artifacts

    reasons: List[str] = []

    # Pair by task: present in both arms with enough real reps in each.
    shared_tasks = sorted(set(base_stats) & set(cand_stats))
    per_task: List[PairedTaskDelta] = []
    dropped = 0
    for task in shared_tasks:
        b = base_stats[task]
        c = cand_stats[task]
        if b.reps < thresholds.min_reps_per_task or c.reps < thresholds.min_reps_per_task:
            dropped += 1
            continue
        b_dps = b.dollars_per_solved
        c_dps = c.dollars_per_solved
        dps_delta = (
            (c_dps - b_dps) if (b_dps is not None and c_dps is not None) else None
        )
        per_task.append(
            PairedTaskDelta(
                task=task,
                baseline_solve_rate=b.solve_rate,
                candidate_solve_rate=c.solve_rate,
                solve_rate_delta=c.solve_rate - b.solve_rate,
                baseline_dollars_per_solved=b_dps,
                candidate_dollars_per_solved=c_dps,
                dollars_per_solved_delta=dps_delta,
                is_tie=(c.solve_rate == b.solve_rate),
                paired_reps=min(b.reps, c.reps),
            )
        )
    # Tasks in only one arm cannot be paired — disclose, don't silently drop.
    unpaired = len(set(base_stats) ^ set(cand_stats))
    dropped += unpaired

    tie_task_count = sum(1 for d in per_task if d.is_tie)

    # Baseline arm's overall $/solved for the relative $ materiality floor.
    base_total_cost = sum(s.total_cost for s in base_stats.values())
    base_total_solved = sum(s.solved for s in base_stats.values())
    baseline_arm_dps = (
        (base_total_cost / base_total_solved) if base_total_solved else None
    )

    solve_leg = _solve_rate_leg(per_task, thresholds)
    dollars_leg = _dollars_leg(per_task, baseline_arm_dps, thresholds)

    # --- Verdict ---------------------------------------------------------
    verdict = _decide(
        per_task=per_task,
        solve_leg=solve_leg,
        dollars_leg=dollars_leg,
        thresholds=thresholds,
        reasons=reasons,
    )

    if dropped:
        reasons.append(f"{dropped} task(s) unpaired or below min reps and dropped")
    if network_artifact_count:
        reasons.append(
            f"{network_artifact_count} <synthetic> network-artifact rep(s) excluded"
        )
    if tie_task_count:
        reasons.append(f"{tie_task_count} tie task(s) kept as paired zeros")

    return RegressionGateReport(
        baseline_arm=baseline_arm,
        candidate_arm=candidate_arm,
        verdict=verdict,
        solve_rate=solve_leg,
        dollars_per_solved=dollars_leg,
        per_task_deltas=per_task,
        thresholds=thresholds,
        tie_task_count=tie_task_count,
        dropped_task_count=dropped,
        network_artifact_count=network_artifact_count,
        reasons=reasons,
    )


def _decide(
    *,
    per_task: Sequence[PairedTaskDelta],
    solve_leg: MetricGateResult,
    dollars_leg: MetricGateResult,
    thresholds: GateThresholds,
    reasons: List[str],
) -> GateVerdict:
    """Resolve the three-way verdict — RED wins, then INSUFFICIENT, else GREEN.

    Order matters. A real, material regression is worth flagging even off a
    thin sample, so RED is checked FIRST (a detected harmful effect is not made
    less real by low power). Only when nothing red does under-power downgrade an
    otherwise-green call to INSUFFICIENT_REPS — never the reverse.
    """
    # 1) RED — either leg detected a material regression (CI excludes zero).
    if solve_leg.regressed:
        reasons.append(
            f"solve-rate regressed: mean delta {solve_leg.mean_delta:+.4f}, "
            f"95% CI [{solve_leg.ci_low:+.4f}, {solve_leg.ci_high:+.4f}] excludes 0, "
            f"|effect| >= materiality {solve_leg.materiality:.4f}"
        )
    if dollars_leg.regressed:
        reasons.append(
            f"$/solved regressed: mean delta {dollars_leg.mean_delta:+.4f}, "
            f"95% CI [{dollars_leg.ci_low:+.4f}, {dollars_leg.ci_high:+.4f}] excludes 0, "
            f"effect >= materiality {dollars_leg.materiality:.4f}"
        )
    if solve_leg.regressed or dollars_leg.regressed:
        return GateVerdict.RED

    # 2) INSUFFICIENT_REPS — too few paired tasks to be confident at all.
    if len(per_task) < thresholds.min_paired_tasks:
        reasons.append(
            f"only {len(per_task)} paired task(s) < min {thresholds.min_paired_tasks} "
            "— under-powered, no confident verdict"
        )
        return GateVerdict.INSUFFICIENT_REPS

    # 3) INSUFFICIENT_REPS — a non-red comparison whose solve-rate leg lacks the
    #    power to have SEEN a material regression. A green here would be "no
    #    regression detected" masquerading as "no regression"; refuse it.
    if solve_leg.underpowered:
        reasons.append(
            f"solve-rate leg under-powered: achieved power {solve_leg.achieved_power:.2f} "
            f"< required {thresholds.min_power:.2f} to detect a "
            f"{thresholds.solve_rate_materiality:.2f} regression"
        )
        return GateVerdict.INSUFFICIENT_REPS

    # 4) GREEN — enough paired tasks, enough power, no material regression.
    reasons.append(
        "no material regression: neither leg's CI excludes zero in the harmful "
        "direction beyond materiality, and the solve-rate comparison is powered"
    )
    return GateVerdict.GREEN


# ---------------------------------------------------------------------------
# Rendering — a human-readable gate report (the "sample gate report" evidence).
# ---------------------------------------------------------------------------

def render_gate_markdown(report: RegressionGateReport) -> str:
    """Render a ``RegressionGateReport`` as markdown for a report artifact.

    Pure string formatting. Surfaces the verdict, both metric legs (delta, CI,
    power, materiality), the per-task paired deltas, and the tie / dropped /
    artifact disclosures — the full evidence a reviewer needs to trust or
    challenge the call (AC3).
    """
    icon = {
        GateVerdict.GREEN: "🟢",
        GateVerdict.RED: "🔴",
        GateVerdict.INSUFFICIENT_REPS: "🟡",
    }[report.verdict]
    lines: List[str] = []
    lines.append(
        f"# Regression gate: `{report.candidate_arm}` vs `{report.baseline_arm}`"
    )
    lines.append("")
    lines.append(f"**Verdict:** {icon} `{report.verdict.value}`")
    lines.append("")
    for reason in report.reasons:
        lines.append(f"- {reason}")
    lines.append("")

    lines.append("## Metric legs")
    lines.append("")
    lines.append(
        "| metric | mean Δ | 95% CI | materiality | n | power | regressed |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    for leg in (report.solve_rate, report.dollars_per_solved):
        mat = "n/a" if not math.isfinite(leg.materiality) else f"{leg.materiality:.4f}"
        lines.append(
            f"| {leg.metric} | {leg.mean_delta:+.4f} | "
            f"[{leg.ci_low:+.4f}, {leg.ci_high:+.4f}] | {mat} | {leg.n} | "
            f"{leg.achieved_power:.2f} | {'yes' if leg.regressed else 'no'} |"
        )
    lines.append("")

    lines.append("## Per-task paired deltas")
    lines.append("")
    lines.append(
        "| task | base solve | cand solve | Δ solve | Δ $/solved | tie |"
    )
    lines.append("|---|---|---|---|---|---|")
    for d in report.per_task_deltas:
        dps = "n/a" if d.dollars_per_solved_delta is None else f"{d.dollars_per_solved_delta:+.4f}"
        lines.append(
            f"| {d.task} | {d.baseline_solve_rate:.2f} | {d.candidate_solve_rate:.2f} | "
            f"{d.solve_rate_delta:+.2f} | {dps} | {'yes' if d.is_tie else ''} |"
        )
    lines.append("")
    lines.append(
        f"_Excluded {report.network_artifact_count} `<synthetic>` network-artifact "
        f"rep(s); {report.tie_task_count} tie task(s); "
        f"{report.dropped_task_count} dropped/unpaired task(s)._"
    )
    lines.append("")
    return "\n".join(lines)
