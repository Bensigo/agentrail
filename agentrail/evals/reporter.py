"""Eval reporter — aggregate repetition records into per-arm metrics (issue #934).

The reporter is the last stage of the eval spine
(``corpus -> arm runner -> scorer -> N repetitions -> reporter``). It takes the
N repetition records for each ``(task, arm)`` pair and produces, per arm:

- **solve-rate** (mean over all repetitions) and **spread** (population stddev
  of the per-task solve fractions, so a 9/10 harness reads differently from a
  5/10 one),
- **dollars-per-solved-task** — the headline cost metric (CONTEXT.md): total
  cost divided by the number of *solved* repetitions, all routed through the
  single-source pricing adapter. Never cost-per-task (which rewards failing
  cheaply); an all-failure arm reports ``None`` (undefined), never a crash.
- **token totals** summed across every repetition.

Outputs (CONTEXT.md honesty rails):

- a dated markdown report committed under ``agentrail/evals/reports/`` that
  surfaces failures, ties, and spread — not only wins; and
- the same per-arm numbers written to Postgres via an injectable
  ``MetricsWriter`` so the console can later show real numbers (closing the
  always-zero context-quality false green).

This module is pure given its inputs except for ``write_markdown_report`` (disk)
and ``write_reports`` (delegates to the injected writer), so the truth-critical
aggregation and rendering are trivially testable.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Protocol, Sequence

from agentrail.run.usage_capture import Usage

from agentrail.evals.arms import LAYER_NAMES, NEW_FLOW_LAYERS
from agentrail.evals.corpus.loader import DIFFICULTY_TAGS
from agentrail.evals.pricing_adapter import usage_cost, usage_cost_breakdown
from agentrail.evals.probes import (
    GuardrailCatchReport,
    RetryAttributionReport,
    RetryLiftReport,
    RoutingAttributionReport,
    RoutingRegretReport,
)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RepetitionRecord:
    """One repetition of a ``(task, arm)`` pair.

    ``solved`` is the hidden-test verdict (the only signal that cannot be
    faked). ``usage`` is the token usage for the run, priced through the
    adapter. This is the contract the reporter depends on; the runner/scorer
    are responsible for producing it.

    ``gate_passed`` and ``false_green`` are carried straight from the scorer's
    ``Verdict`` (issue #940) so the Objective Gate false-green RATE can be
    aggregated here WITHOUT re-deriving the per-run flag — the false-green
    definition stays single-sourced in ``scorer.score``. They default to
    ``False`` so callers that pre-date the probe (and tests) keep constructing
    a record positionally; the spine always sets them from the ``Verdict``.
    """

    task: str
    arm: str
    solved: bool
    usage: Usage
    gate_passed: bool = False
    false_green: bool = False
    # Difficulty stratum of the task this rep belongs to (issue #941), threaded
    # from the ``CorpusTask`` by the spine so the reporter can break metrics out
    # PER stratum — a single aggregate hides the harness's real story (the edge
    # is large on hard scattered-context tasks, small on easy single-file ones).
    # ``None`` for callers (and old tests) that pre-date the probe; such records
    # simply contribute to no stratum (the aggregate is unaffected).
    difficulty: Optional[str] = None
    # Wall-clock duration of the run, in seconds (issue #980). Threaded straight
    # from the runner's ``RunRecord.wall_time_s`` by the spine so the report can
    # surface wall-time PER TASK per arm — a falsifiable metric (a slower arm
    # reads worse). Defaults to ``0.0`` for callers/tests that pre-date it.
    wall_time_s: float = 0.0
    # Diagnostic fields (issue #994), threaded straight from the runner's
    # ``RunRecord`` by the spine so a FAILED run is diagnosable in the report —
    # before this, a non-solved run carried no reason and no context-quality
    # signal, so every failure was opaque. All default to ``None`` (undefined)
    # so pre-#994 callers/tests construct a record positionally unchanged, and
    # ``None`` stays distinct from a measured ``0.0``.
    diff: Optional[str] = None
    gate_failure_reason: Optional[str] = None
    precision_at_budget: Optional[float] = None
    citation_coverage: Optional[float] = None


# ---------------------------------------------------------------------------
# Per-arm aggregate
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StratumReport:
    """Per-difficulty-stratum metrics for one arm (issue #941).

    Carries the same shape as the headline arm metrics, scoped to the reps of a
    single difficulty (easy / medium / hard). Reported IN ADDITION TO the
    aggregate so a single solve-rate never hides the per-stratum story.
    ``dollars_per_solved`` is ``None`` when no rep in the stratum solved (same
    undefined-denominator rule as the aggregate — never divide by zero).
    """

    difficulty: str
    repetitions: int
    solved_count: int
    failed_count: int
    solve_rate: float
    total_cost_usd: float
    dollars_per_solved: Optional[float]


@dataclass(frozen=True)
class ArmReport:
    """Aggregated metrics for a single arm across all its repetition records."""

    arm: str
    repetitions: int
    solved_count: int
    failed_count: int
    solve_rate: float          # mean over all repetitions, in [0, 1]
    spread: float              # population stddev of per-task solve fractions
    total_input_tokens: int
    total_output_tokens: int
    total_cache_tokens: int
    total_cache_creation_tokens: int
    total_tokens: int
    total_cost_usd: float
    # None when no repetition solved (undefined, never divide-by-zero).
    dollars_per_solved: Optional[float]
    # Wall-time per task (issue #980): mean over all repetitions (seconds), and
    # the total across them. The MEAN is the headline "wall-time per task" AC3
    # asks for; it is falsifiable — a slower arm comes back larger. ``0.0`` when
    # no repetitions (never a divide-by-zero).
    mean_wall_time_s: float = 0.0
    total_wall_time_s: float = 0.0
    # Objective Gate false-green probe (issue #940). Of the runs whose gate
    # passed, how many failed the hidden tests. The flags are the scorer's
    # (carried on each RepetitionRecord), never re-derived here.
    gate_passed_count: int = 0
    false_green_count: int = 0
    # None when NO run's gate passed (undefined denominator) — DISTINCT from a
    # 0.0 rate (gate passed but never a false-green). Never divide-by-zero.
    false_green_rate: Optional[float] = None
    # per-task solve fractions, kept for transparency in the report.
    per_task_solve_rate: Dict[str, float] = field(default_factory=dict)
    # Difficulty-stratified breakdown (issue #941), in canonical difficulty
    # order (easy/medium/hard). Empty when no record carried a difficulty.
    strata: List[StratumReport] = field(default_factory=list)
    # Context-pack quality (issue #994): mean precision_at_budget /
    # citation_coverage over the reps THAT CARRIED them. ``None`` when no rep in
    # this arm captured the metric (undefined) — DISTINCT from a measured 0.0.
    # The live sandbox executor does not yet surface these, so they are commonly
    # ``None`` today; the report renders that honestly as "n/a".
    mean_precision_at_budget: Optional[float] = None
    mean_citation_coverage: Optional[float] = None
    # Per-component dollar split of ``total_cost_usd`` (issue: cost breakdown).
    # Summed per-record through the single-source breakdown, so the four
    # components sum to ``total_cost_usd`` exactly even when records in the arm
    # used different models. Defaulted to 0.0 so positional construction in
    # existing tests stays valid. The four ALWAYS sum to ``total_cost_usd``.
    input_cost_usd: float = 0.0
    output_cost_usd: float = 0.0
    cache_read_cost_usd: float = 0.0
    cache_write_cost_usd: float = 0.0


def _arm_report(arm: str, records: Sequence[RepetitionRecord]) -> ArmReport:
    repetitions = len(records)
    solved_count = sum(1 for r in records if r.solved)
    failed_count = repetitions - solved_count

    solve_rate = solved_count / repetitions if repetitions else 0.0

    # Per-task solve fractions -> spread is the population stddev across tasks.
    per_task_solved: Dict[str, int] = defaultdict(int)
    per_task_total: Dict[str, int] = defaultdict(int)
    for r in records:
        per_task_total[r.task] += 1
        if r.solved:
            per_task_solved[r.task] += 1
    per_task_solve_rate = {
        task: per_task_solved[task] / per_task_total[task]
        for task in sorted(per_task_total)
    }
    fractions = list(per_task_solve_rate.values())
    # population stddev; defined as 0 for a single task (no spread to report).
    spread = statistics.pstdev(fractions) if len(fractions) > 1 else 0.0

    total_input = sum(r.usage.input_tokens for r in records)
    total_output = sum(r.usage.output_tokens for r in records)
    total_cache = sum(r.usage.cache_tokens for r in records)
    total_cache_creation = sum(
        getattr(r.usage, "cache_creation_tokens", 0) for r in records
    )
    total_tokens = total_input + total_output + total_cache + total_cache_creation

    total_cost = sum(usage_cost(r.usage) for r in records)

    # Per-component dollar split, summed per-record through the single-source
    # breakdown. Records in one arm can use different models (e.g. plan vs
    # execute vs verify phases), so we cannot multiply the arm's token totals by
    # a single rate — each record is priced at its own model's rates and the
    # components accumulated. By the per-record parity invariant
    # (breakdown total == usage_cost), these four sum to ``total_cost`` to within
    # float epsilon; ``total_cost_usd`` stays the authoritative total. Compute
    # each record's breakdown once, then accumulate (not four passes per record).
    _breakdowns = [usage_cost_breakdown(r.usage) for r in records]
    input_cost = sum(bd["input_usd"] for bd in _breakdowns)
    output_cost = sum(bd["output_usd"] for bd in _breakdowns)
    cache_read_cost = sum(bd["cache_read_usd"] for bd in _breakdowns)
    cache_write_cost = sum(bd["cache_write_usd"] for bd in _breakdowns)

    # Headline cost metric: dollars per *solved* task. Undefined (None) when
    # nothing solved — the AC3 no-divide-by-zero guard.
    dollars_per_solved = (total_cost / solved_count) if solved_count else None

    # Wall-time per task (#980): total + mean over all repetitions. ``0.0`` for
    # an empty arm (never a divide-by-zero). Falsifiable — a slower arm reads
    # worse because the mean comes back larger.
    total_wall_time = sum(getattr(r, "wall_time_s", 0.0) for r in records)
    mean_wall_time = (total_wall_time / repetitions) if repetitions else 0.0

    # Objective Gate false-green probe (#940). Both flags come straight off the
    # RepetitionRecord (which the spine fills from the scorer's Verdict) — we
    # only COUNT them here, never recompute "gate passed and not solved".
    gate_passed_count = sum(1 for r in records if r.gate_passed)
    false_green_count = sum(1 for r in records if r.false_green)
    # Undefined when the denominator is empty (no gate-passed run). None — NOT
    # 0.0 — so "the gate never passed" reads differently from "the gate passed
    # but never lied".
    false_green_rate = (
        (false_green_count / gate_passed_count) if gate_passed_count else None
    )

    strata = _strata(records)

    # Context-pack quality (#994): mean over ONLY the reps that carried a metric
    # (None defaults are skipped). ``None`` when no rep carried it — undefined,
    # never a fabricated 0.0.
    precisions = [
        r.precision_at_budget for r in records if r.precision_at_budget is not None
    ]
    coverages = [
        r.citation_coverage for r in records if r.citation_coverage is not None
    ]
    mean_precision = (sum(precisions) / len(precisions)) if precisions else None
    mean_coverage = (sum(coverages) / len(coverages)) if coverages else None

    return ArmReport(
        arm=arm,
        repetitions=repetitions,
        solved_count=solved_count,
        failed_count=failed_count,
        solve_rate=solve_rate,
        spread=spread,
        total_input_tokens=total_input,
        total_output_tokens=total_output,
        total_cache_tokens=total_cache,
        total_cache_creation_tokens=total_cache_creation,
        total_tokens=total_tokens,
        total_cost_usd=total_cost,
        dollars_per_solved=dollars_per_solved,
        mean_wall_time_s=mean_wall_time,
        total_wall_time_s=total_wall_time,
        gate_passed_count=gate_passed_count,
        false_green_count=false_green_count,
        false_green_rate=false_green_rate,
        per_task_solve_rate=per_task_solve_rate,
        strata=strata,
        mean_precision_at_budget=mean_precision,
        mean_citation_coverage=mean_coverage,
        input_cost_usd=input_cost,
        output_cost_usd=output_cost,
        cache_read_cost_usd=cache_read_cost,
        cache_write_cost_usd=cache_write_cost,
    )


def _strata(records: Sequence[RepetitionRecord]) -> List[StratumReport]:
    """Break an arm's records out per difficulty stratum (issue #941).

    Records with no ``difficulty`` (pre-#941 callers/tests) contribute to no
    stratum, so the aggregate is unaffected and back-compat is preserved.
    Strata are returned in canonical difficulty order so reports are
    deterministic.
    """
    by_diff: Dict[str, List[RepetitionRecord]] = defaultdict(list)
    for r in records:
        if r.difficulty is not None:
            by_diff[r.difficulty].append(r)

    # Canonical order first, then any unexpected tag (sorted) so a stray
    # difficulty still surfaces rather than being silently dropped.
    ordered = [d for d in DIFFICULTY_TAGS if d in by_diff]
    ordered += sorted(d for d in by_diff if d not in DIFFICULTY_TAGS)

    reports: List[StratumReport] = []
    for difficulty in ordered:
        recs = by_diff[difficulty]
        reps = len(recs)
        solved = sum(1 for r in recs if r.solved)
        cost = sum(usage_cost(r.usage) for r in recs)
        reports.append(
            StratumReport(
                difficulty=difficulty,
                repetitions=reps,
                solved_count=solved,
                failed_count=reps - solved,
                solve_rate=(solved / reps) if reps else 0.0,
                total_cost_usd=cost,
                # Same undefined-denominator rule as the aggregate.
                dollars_per_solved=(cost / solved) if solved else None,
            )
        )
    return reports


def aggregate(records: Sequence[RepetitionRecord]) -> List[ArmReport]:
    """Aggregate repetition records into one ``ArmReport`` per arm.

    Deterministic: arms are returned sorted by name so repeated runs over the
    same records produce identical output (and identical committed reports).
    """
    by_arm: Dict[str, List[RepetitionRecord]] = defaultdict(list)
    for record in records:
        by_arm[record.arm].append(record)
    return [_arm_report(arm, by_arm[arm]) for arm in sorted(by_arm)]


# ---------------------------------------------------------------------------
# Per-layer leave-one-out ablation deltas (issue #939)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LayerDelta:
    """One layer's leave-one-out contribution (CONTEXT.md / PRD §ablation).

    The delta is ``full`` minus ``full-minus-<layer>`` on the SAME run set /
    scorer — never a different baseline. A large positive delta means the layer
    earns its place; a zero or negative delta means it should be fixed or
    removed.

    ``delta`` is ``None`` (undefined) when either the ``full`` arm or this
    layer's ``full-minus-<layer>`` arm is absent from the run set — we report
    the gap honestly rather than fabricating a number or crashing. An undefined
    delta is neither flagged nor earning its place (both ``False``).
    """

    layer: str
    full_solve_rate: Optional[float]
    ablation_solve_rate: Optional[float]
    delta: Optional[float]  # full - ablation; None when either arm is absent.

    @property
    def earns_place(self) -> bool:
        """True iff the delta is defined and strictly positive."""
        return self.delta is not None and self.delta > 0.0

    @property
    def flagged(self) -> bool:
        """True iff the delta is defined and <= 0 (candidate to fix/remove)."""
        return self.delta is not None and self.delta <= 0.0


def layer_deltas(reports: Sequence[ArmReport]) -> List[LayerDelta]:
    """Per-layer ablation deltas across the given arm reports.

    For each layer (in :data:`LAYER_NAMES` order) compute::

        delta = full.solve_rate - (full-minus-<layer>).solve_rate

    over the SAME run set the reports were aggregated from. When either the
    ``full`` arm or the layer's ``full-minus-<layer>`` arm is missing from
    *reports*, the delta is ``None`` (undefined) — never a crash and never a
    guessed baseline.
    """
    by_arm = {r.arm: r for r in reports}
    full_report = by_arm.get("full")
    full_rate = full_report.solve_rate if full_report is not None else None

    deltas: List[LayerDelta] = []
    for layer in LAYER_NAMES:
        ablation = by_arm.get(f"full-minus-{layer}")
        ablation_rate = ablation.solve_rate if ablation is not None else None
        if full_rate is None or ablation_rate is None:
            delta: Optional[float] = None
        else:
            delta = full_rate - ablation_rate
        deltas.append(
            LayerDelta(
                layer=layer,
                full_solve_rate=full_rate,
                ablation_solve_rate=ablation_rate,
                delta=delta,
            )
        )
    return deltas


# ---------------------------------------------------------------------------
# New-flow per-layer ablation deltas (issue #980) — same shape as the base
# layer deltas, but computed against the NEW-FLOW arm and its
# ``new-flow-minus-<layer>`` ablations (critic / best-of-N / warm-cache).
# ---------------------------------------------------------------------------


def new_flow_layer_deltas(reports: Sequence[ArmReport]) -> List[LayerDelta]:
    """Per-new-layer ablation deltas across the given arm reports (issue #980 AC1).

    For each new-flow layer (in :data:`NEW_FLOW_LAYERS` order) compute::

        delta = new-flow.solve_rate - (new-flow-minus-<layer>).solve_rate

    over the SAME run set the reports were aggregated from. Mirrors
    :func:`layer_deltas` exactly (same ``LayerDelta`` shape, same
    ``earns_place`` / ``flagged`` semantics, same undefined-when-absent rule) —
    only the anchor arm (``new-flow``) and the ablation-arm name prefix differ.
    When either the ``new-flow`` arm or a layer's ``new-flow-minus-<layer>`` arm
    is missing, that layer's delta is ``None`` (undefined) — never a crash.
    """
    by_arm = {r.arm: r for r in reports}
    nf_report = by_arm.get("new-flow")
    nf_rate = nf_report.solve_rate if nf_report is not None else None

    deltas: List[LayerDelta] = []
    for layer in NEW_FLOW_LAYERS:
        ablation = by_arm.get(f"new-flow-minus-{layer}")
        ablation_rate = ablation.solve_rate if ablation is not None else None
        if nf_rate is None or ablation_rate is None:
            delta: Optional[float] = None
        else:
            delta = nf_rate - ablation_rate
        deltas.append(
            LayerDelta(
                layer=layer,
                full_solve_rate=nf_rate,
                ablation_solve_rate=ablation_rate,
                delta=delta,
            )
        )
    return deltas


# ---------------------------------------------------------------------------
# New-flow vs ``full`` head-to-head delta (issue #980 AC3) — the four headline
# metrics, EACH able to come back worse (no one-sided metric).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NewFlowDelta:
    """New-flow-vs-``full`` delta on the four headline metrics (issue #980 AC3).

    Every delta is ``new-flow`` minus ``full`` on the SAME run set / scorer.
    Each is falsifiable — it can come back WORSE:

    - ``solve_rate_delta`` — higher is better, so a positive delta is good; a
      negative one means the new flow solved fewer.
    - ``dollars_per_solved_delta`` — lower is better, so a NEGATIVE delta is
      good (cheaper); a positive one means the new flow cost more per solved
      task. ``None`` when either arm never solved (undefined $/solved).
    - ``wall_time_delta`` — lower is better, so a positive delta means the new
      flow was SLOWER per task (worse). This is the metric most likely to come
      back worse — the warm-cache / best-of-N layers trade wall-time for solves.
    - ``false_green_rate_delta`` — lower is better, so a negative delta is good
      (fewer false greens). ``None`` when either arm's denominator is empty.

    The source rates are carried for transparency (and so the markdown / rows
    never re-derive them).
    """

    full_solve_rate: float
    new_flow_solve_rate: float
    solve_rate_delta: float

    full_dollars_per_solved: Optional[float]
    new_flow_dollars_per_solved: Optional[float]
    dollars_per_solved_delta: Optional[float]

    full_mean_wall_time_s: float
    new_flow_mean_wall_time_s: float
    wall_time_delta: float

    full_false_green_rate: Optional[float]
    new_flow_false_green_rate: Optional[float]
    false_green_rate_delta: Optional[float]


def _opt_delta(new: Optional[float], base: Optional[float]) -> Optional[float]:
    """``new - base`` when both are defined, else ``None`` (no fabricated number)."""
    if new is None or base is None:
        return None
    return new - base


def new_flow_delta(reports: Sequence[ArmReport]) -> Optional[NewFlowDelta]:
    """The ``new-flow`` vs ``full`` head-to-head delta, or ``None`` when an arm is absent.

    Returns ``None`` (undefined — never a fabricated row) unless BOTH the
    ``full`` and ``new-flow`` arms are in *reports*. Each metric delta is
    ``new-flow`` minus ``full``; the dollars-per-solved and false-green-rate
    deltas are ``None`` when either side's metric is undefined (no
    divide-by-zero, no one-sided number).
    """
    by_arm = {r.arm: r for r in reports}
    full_r = by_arm.get("full")
    nf_r = by_arm.get("new-flow")
    if full_r is None or nf_r is None:
        return None
    return NewFlowDelta(
        full_solve_rate=full_r.solve_rate,
        new_flow_solve_rate=nf_r.solve_rate,
        solve_rate_delta=nf_r.solve_rate - full_r.solve_rate,
        full_dollars_per_solved=full_r.dollars_per_solved,
        new_flow_dollars_per_solved=nf_r.dollars_per_solved,
        dollars_per_solved_delta=_opt_delta(
            nf_r.dollars_per_solved, full_r.dollars_per_solved
        ),
        full_mean_wall_time_s=full_r.mean_wall_time_s,
        new_flow_mean_wall_time_s=nf_r.mean_wall_time_s,
        wall_time_delta=nf_r.mean_wall_time_s - full_r.mean_wall_time_s,
        full_false_green_rate=full_r.false_green_rate,
        new_flow_false_green_rate=nf_r.false_green_rate,
        false_green_rate_delta=_opt_delta(
            nf_r.false_green_rate, full_r.false_green_rate
        ),
    )


# ---------------------------------------------------------------------------
# Markdown rendering (honesty rails: failures, ties, spread — not only wins)
# ---------------------------------------------------------------------------

_UNDEFINED = "n/a"


def _fmt_usd(value: Optional[float]) -> str:
    if value is None:
        return _UNDEFINED
    return f"${value:.4f}"


def _fmt_pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def _fmt_seconds(value: float) -> str:
    return f"{value:.1f}s"


def _fmt_signed_seconds(value: float) -> str:
    return f"{value:+.1f}s"


def _fmt_signed_usd(value: Optional[float]) -> str:
    if value is None:
        return _UNDEFINED
    return f"{'+' if value >= 0 else '-'}${abs(value):.4f}"


def _fmt_signed_pct(value: Optional[float]) -> str:
    if value is None:
        return _UNDEFINED
    return f"{value * 100:+.1f}%"


def _fmt_rate_pct(value: Optional[float]) -> str:
    """Percentage formatter that preserves the None-vs-0.0 distinction.

    ``None`` (undefined denominator) renders as ``n/a``; ``0.0`` renders as
    ``0.0%`` — so a never-gate-passed arm never masquerades as a clean one.
    """
    if value is None:
        return _UNDEFINED
    return _fmt_pct(value)


def _cost_share(component: float, total: float) -> Optional[float]:
    """Return *component*'s share of *total*, or ``None`` when *total* is zero.

    ``None`` (→ ``n/a``) when the arm spent nothing, so a zero-spend arm reads
    differently from a genuine 0%-share component — and never a divide-by-zero.
    """
    return (component / total) if total else None


def _fmt_ratio(value: Optional[float]) -> str:
    """Format a 0..1 quality ratio, preserving the None-vs-0.0 distinction (#994).

    ``None`` (not captured / undefined) renders as ``n/a``; a measured ``0.0``
    renders as ``0.000`` — so "we never measured it" never masquerades as a
    measured-zero precision/coverage.
    """
    if value is None:
        return _UNDEFINED
    return f"{value:.3f}"


# Per-failed-run diff is truncated so the report stays readable; the FULL diff
# lives on the RunRecord / sandbox, this is a diagnostic excerpt (#994).
_DIFF_PREVIEW_LINES = 50


def _abbreviated_diff(diff: Optional[str]) -> List[str]:
    """Render a failed run's diff as fenced markdown, truncated to a preview.

    Returns the lines to append (a fenced code block), or a single honest line
    when there is no diff to show. Truncation is explicit ("… N more lines")
    so the reader knows the excerpt is partial — the full diff is on the record.
    """
    if not diff or not diff.strip():
        return ["  - Diff: _(empty — agent produced no change)_"]
    raw = diff.splitlines()
    shown = raw[:_DIFF_PREVIEW_LINES]
    out = ["  - Diff (first %d lines):" % min(len(raw), _DIFF_PREVIEW_LINES), "", "    ```diff"]
    out.extend(f"    {line}" for line in shown)
    if len(raw) > _DIFF_PREVIEW_LINES:
        out.append(f"    … {len(raw) - _DIFF_PREVIEW_LINES} more lines")
    out.append("    ```")
    return out


def _tie_tasks(report: ArmReport) -> List[str]:
    """Tasks whose solve fraction is a tie (strictly between 0 and 1).

    A task that is neither always-solved nor always-failed across its
    repetitions is a "tie" — the harness flips on it. Surfacing these keeps the
    report honest: a 0.5 solve fraction is unreliability, not a win.
    """
    return [
        task
        for task, frac in report.per_task_solve_rate.items()
        if 0.0 < frac < 1.0
    ]


def render_markdown(
    reports: Sequence[ArmReport],
    *,
    generated_at: str,
    records: Optional[Sequence[RepetitionRecord]] = None,
) -> str:
    """Render the per-arm reports as a markdown document.

    Always reports failures, ties, and spread alongside wins (CONTEXT.md
    honesty rail). Uses the project's domain language: solve-rate,
    dollars-per-solved-task, spread.

    ``records`` (issue #994) is the OPTIONAL flat list of per-rep records the
    aggregates were built from. When supplied, the failure section additionally
    surfaces each FAILED run's diagnostic detail (its gate-failure reason and an
    abbreviated diff) and the per-run context-pack quality — so a failed run is
    actually diagnosable instead of being just a count. When ``None`` (existing
    callers that pre-date #994), the report renders exactly as before — the new
    detail is simply omitted, never fabricated. The aggregate "## Context
    quality" section is driven by the ``ArmReport`` fields and renders either way.
    """
    lines: List[str] = []
    lines.append("# AgentRail eval report")
    lines.append("")
    lines.append(f"Generated: {generated_at}")
    lines.append("")
    lines.append(
        "Headline cost metric is **dollars-per-solved-task** (never cost per "
        "task). Reports include failures, ties, and spread — not only wins. All "
        "dollar figures route through the single-source pricing module."
    )
    lines.append("")

    if not reports:
        lines.append("_No repetition records to report._")
        lines.append("")
        return "\n".join(lines)

    # --- Per-arm summary table -------------------------------------------
    lines.append("## Per-arm summary")
    lines.append("")
    lines.append(
        "| Arm | Reps | Solved | Failed | Solve-rate | Spread | "
        "False-green rate | Wall-time per task | Total tokens | Total cost "
        "| Dollars-per-solved-task |"
    )
    lines.append(
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    )
    for r in reports:
        lines.append(
            f"| {r.arm} | {r.repetitions} | {r.solved_count} | {r.failed_count} "
            f"| {_fmt_pct(r.solve_rate)} | {r.spread:.4f} "
            f"| {_fmt_rate_pct(r.false_green_rate)} "
            f"| {_fmt_seconds(r.mean_wall_time_s)} "
            f"| {r.total_tokens} | {_fmt_usd(r.total_cost_usd)} "
            f"| {_fmt_usd(r.dollars_per_solved)} |"
        )
    lines.append("")

    # --- Cost breakdown: where the dollars go ----------------------------
    # The per-arm summary shows ONLY the total; this splits it into the four
    # priced components (input / output / cache-read / cache-write) so a cost
    # change is attributable — e.g. a warm-cache win shows up as cache-read
    # dollars rising while input dollars fall. The four components sum to the
    # arm's Total cost (single-source breakdown, parity-tested). The % column
    # is each component's share of that arm's total.
    lines.append("## Cost breakdown")
    lines.append("")
    lines.append(
        "Per-arm split of **Total cost** into its four priced components "
        "(input, output, cache-read, cache-write). All figures route through "
        "the single-source pricing module, and the four components sum to the "
        "arm's total cost. The `%` columns are each component's share of that "
        "arm's total cost (`n/a` when the arm spent nothing)."
    )
    lines.append("")
    lines.append(
        "| Arm | Input $ | Input % | Output $ | Output % | Cache-read $ "
        "| Cache-read % | Cache-write $ | Cache-write % | Total $ |"
    )
    lines.append(
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    )
    for r in reports:
        total = r.total_cost_usd
        lines.append(
            f"| {r.arm} "
            f"| {_fmt_usd(r.input_cost_usd)} | {_fmt_rate_pct(_cost_share(r.input_cost_usd, total))} "
            f"| {_fmt_usd(r.output_cost_usd)} | {_fmt_rate_pct(_cost_share(r.output_cost_usd, total))} "
            f"| {_fmt_usd(r.cache_read_cost_usd)} "
            f"| {_fmt_rate_pct(_cost_share(r.cache_read_cost_usd, total))} "
            f"| {_fmt_usd(r.cache_write_cost_usd)} "
            f"| {_fmt_rate_pct(_cost_share(r.cache_write_cost_usd, total))} "
            f"| {_fmt_usd(r.total_cost_usd)} |"
        )
    lines.append("")

    # --- New-flow vs `full` head-to-head delta (issue #980 AC3) ----------
    # All four headline metrics, EACH able to come back worse (no one-sided
    # metric). Only rendered when BOTH arms are present in this run set.
    nf_delta = new_flow_delta(reports)
    lines.append("## New-flow vs full")
    lines.append("")
    if nf_delta is None:
        lines.append(
            "_Not available: this run set does not contain BOTH the `full` and "
            "`new-flow` arms (run `--arm full --arm new-flow` to populate this)._"
        )
        lines.append("")
    else:
        lines.append(
            "The new flow is `full` PLUS the critic (#977), best-of-N (#979), and "
            "warm-cache (#978) layers. Each delta is `new-flow` minus `full` on the "
            "SAME scorer and run set, and each can come back **worse** — solve-rate "
            "and false-green can drop, wall-time and dollars-per-solved can rise. "
            "Lower is better for dollars-per-solved, wall-time, and false-green; "
            "higher is better for solve-rate. `n/a` marks an undefined delta "
            "(an arm never solved, or its gate never passed)."
        )
        lines.append("")
        lines.append("| Metric | full | new-flow | Delta (new-flow - full) |")
        lines.append("| --- | ---: | ---: | ---: |")
        lines.append(
            f"| Solve-rate | {_fmt_pct(nf_delta.full_solve_rate)} | "
            f"{_fmt_pct(nf_delta.new_flow_solve_rate)} | "
            f"{_fmt_signed_pct(nf_delta.solve_rate_delta)} |"
        )
        lines.append(
            f"| Dollars-per-solved-task | "
            f"{_fmt_usd(nf_delta.full_dollars_per_solved)} | "
            f"{_fmt_usd(nf_delta.new_flow_dollars_per_solved)} | "
            f"{_fmt_signed_usd(nf_delta.dollars_per_solved_delta)} |"
        )
        lines.append(
            f"| Wall-time per task | "
            f"{_fmt_seconds(nf_delta.full_mean_wall_time_s)} | "
            f"{_fmt_seconds(nf_delta.new_flow_mean_wall_time_s)} | "
            f"{_fmt_signed_seconds(nf_delta.wall_time_delta)} |"
        )
        lines.append(
            f"| False-green rate | "
            f"{_fmt_rate_pct(nf_delta.full_false_green_rate)} | "
            f"{_fmt_rate_pct(nf_delta.new_flow_false_green_rate)} | "
            f"{_fmt_signed_pct(nf_delta.false_green_rate_delta)} |"
        )
        lines.append("")

    # --- Per-layer ablation deltas (issue #939) --------------------------
    # full - full-minus-<layer> on the same scorer/run set. A large positive
    # delta means the layer earns its place; <= 0 means fix or remove it.
    deltas = layer_deltas(reports)
    lines.append("## Per-layer ablation deltas")
    lines.append("")
    lines.append(
        "Each layer's worth is `full` solve-rate minus `full-minus-<layer>` "
        "solve-rate on the SAME scorer and run set. A positive delta means the "
        "layer **earns its place**; a zero or negative delta flags it as a "
        "**candidate to fix or remove**. `n/a` means the `full` arm or that "
        "layer's ablation arm was absent from this run set (delta undefined)."
    )
    lines.append("")
    lines.append("| Layer | full solve-rate | full-minus-layer solve-rate | Delta | Verdict |")
    lines.append("| --- | ---: | ---: | ---: | --- |")
    for d in deltas:
        full_cell = _fmt_rate_pct(d.full_solve_rate)
        abl_cell = _fmt_rate_pct(d.ablation_solve_rate)
        if d.delta is None:
            delta_cell = _UNDEFINED
            verdict_cell = "n/a (delta undefined — arm absent)"
        else:
            delta_cell = f"{d.delta * 100:+.1f}%"
            verdict_cell = (
                "earns its place"
                if d.earns_place
                else "FLAGGED: candidate to fix or remove (delta <= 0)"
            )
        lines.append(
            f"| {d.layer} | {full_cell} | {abl_cell} | {delta_cell} | {verdict_cell} |"
        )
    lines.append("")
    flagged = [d.layer for d in deltas if d.flagged]
    if flagged:
        lines.append(
            f"**Flagged layers (zero or negative delta — fix or remove): "
            f"{', '.join(flagged)}.**"
        )
    else:
        lines.append(
            "_No layer has a zero or negative delta in this run set._"
        )
    lines.append("")

    # --- New-flow per-layer ablation deltas (issue #980 AC1) -------------
    # new-flow - new-flow-minus-<layer> for each of the three NEW layers
    # (critic / best-of-N / warm-cache). Same earns-its-place / flagged
    # semantics as the base ablation table above.
    nf_deltas = new_flow_layer_deltas(reports)
    lines.append("## New-flow per-layer ablation deltas")
    lines.append("")
    lines.append(
        "Each new layer's worth is `new-flow` solve-rate minus "
        "`new-flow-minus-<layer>` solve-rate on the SAME scorer and run set "
        "(critic #977 / bestofn #979 / warmcache #978). These layers are NOT in "
        "`full` (critic and best-of-N are opt-in; warm-cache is default-on), so "
        "they are ablated relative to the NEW flow, never minused from `full`. A "
        "positive delta means the layer **earns its place**; a zero or negative "
        "delta flags it as a **candidate to fix or remove**. `n/a` means the "
        "`new-flow` arm or that layer's ablation arm was absent (delta undefined)."
    )
    lines.append("")
    lines.append(
        "| Layer | new-flow solve-rate | new-flow-minus-layer solve-rate | Delta | Verdict |"
    )
    lines.append("| --- | ---: | ---: | ---: | --- |")
    for d in nf_deltas:
        full_cell = _fmt_rate_pct(d.full_solve_rate)
        abl_cell = _fmt_rate_pct(d.ablation_solve_rate)
        if d.delta is None:
            delta_cell = _UNDEFINED
            verdict_cell = "n/a (delta undefined — arm absent)"
        else:
            delta_cell = f"{d.delta * 100:+.1f}%"
            verdict_cell = (
                "earns its place"
                if d.earns_place
                else "FLAGGED: candidate to fix or remove (delta <= 0)"
            )
        lines.append(
            f"| {d.layer} | {full_cell} | {abl_cell} | {delta_cell} | {verdict_cell} |"
        )
    lines.append("")
    nf_flagged = [d.layer for d in nf_deltas if d.flagged]
    if nf_flagged:
        lines.append(
            f"**Flagged new-flow layers (zero or negative delta — fix or remove): "
            f"{', '.join(nf_flagged)}.**"
        )
    else:
        lines.append(
            "_No new-flow layer has a zero or negative delta in this run set._"
        )
    lines.append("")

    # --- Difficulty-stratified breakdown (issue #941) --------------------
    # A single aggregate hides the real story: the harness's edge is large on
    # hard, scattered-context tasks and small on easy single-file ones. Report
    # solve-rate / cost / $-per-solved PER stratum, in addition to the headline.
    any_strata = any(r.strata for r in reports)
    lines.append("## Difficulty-stratified breakdown")
    lines.append("")
    if not any_strata:
        lines.append(
            "_No per-difficulty data in this run set (records carried no "
            "difficulty tag)._"
        )
        lines.append("")
    else:
        lines.append(
            "Solve-rate, cost, and dollars-per-solved-task broken out per "
            "difficulty stratum (easy / medium / hard, proxied by "
            "required-context scatter), IN ADDITION TO the aggregate above. A "
            "single aggregate hides the harness's real edge, which is large on "
            "hard scattered-context tasks and small on easy single-file ones."
        )
        lines.append("")
        lines.append(
            "| Arm | Difficulty | Reps | Solved | Failed | Solve-rate | "
            "Total cost | Dollars-per-solved-task |"
        )
        lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for r in reports:
            if not r.strata:
                lines.append(
                    f"| {r.arm} | _(no difficulty data)_ | | | | | | |"
                )
                continue
            for s in r.strata:
                lines.append(
                    f"| {r.arm} | {s.difficulty} | {s.repetitions} | "
                    f"{s.solved_count} | {s.failed_count} | "
                    f"{_fmt_pct(s.solve_rate)} | {_fmt_usd(s.total_cost_usd)} | "
                    f"{_fmt_usd(s.dollars_per_solved)} |"
                )
        lines.append("")

    # --- Honesty section: failures, ties, spread per arm -----------------
    lines.append("## Failures, ties, and spread")
    lines.append("")
    for r in reports:
        lines.append(f"### Arm: {r.arm}")
        lines.append("")
        lines.append(f"- Failed repetitions: {r.failed_count} of {r.repetitions}")
        ties = _tie_tasks(r)
        if ties:
            lines.append(
                f"- Tie tasks (solved on some reps, failed on others): "
                f"{', '.join(ties)}"
            )
        else:
            lines.append("- Tie tasks: none")
        lines.append(
            f"- Spread (population stddev of per-task solve-rate): {r.spread:.4f}"
        )
        # Objective Gate false-green probe (#940): of the gate-passed runs, the
        # fraction whose hidden tests failed (the gate said "done", the ground
        # truth disagreed). The most operationally important number we report.
        if r.false_green_rate is None:
            lines.append(
                "- Objective Gate false-green rate: n/a (undefined — no run's "
                "gate passed, so the denominator is empty; NOT a 0% rate)"
            )
        else:
            lines.append(
                f"- Objective Gate false-green rate: "
                f"{_fmt_rate_pct(r.false_green_rate)} "
                f"({r.false_green_count} of {r.gate_passed_count} gate-passed "
                "runs failed the hidden tests)"
            )
        if r.dollars_per_solved is None:
            lines.append(
                "- Dollars-per-solved-task: n/a (undefined — no repetition "
                f"solved; total cost {_fmt_usd(r.total_cost_usd)} was spent on "
                "failures)"
            )
        else:
            lines.append(
                f"- Dollars-per-solved-task: {_fmt_usd(r.dollars_per_solved)}"
            )
        # Per-task breakdown so a single average never hides the story.
        if r.per_task_solve_rate:
            lines.append("- Per-task solve-rate:")
            for task, frac in r.per_task_solve_rate.items():
                lines.append(f"  - {task}: {_fmt_pct(frac)}")

        # Per-failed-run diagnostics (#994): when the caller threaded the raw
        # per-rep records, surface WHY each failed run failed — its gate-failure
        # reason, an abbreviated diff, and per-run context-pack quality — so a
        # failure is diagnosable, not just counted. Omitted (not fabricated)
        # when records were not supplied.
        if records is not None:
            failed = [
                rec for rec in records if rec.arm == r.arm and not rec.solved
            ]
            if failed:
                lines.append("- Failed-run detail:")
                for rec in failed:
                    reason = rec.gate_failure_reason or "no reason captured"
                    lines.append(f"  - **{rec.task}** — gate: {reason}")
                    cq_parts = []
                    if rec.precision_at_budget is not None or rec.citation_coverage is not None:
                        cq_parts.append(
                            f"precision@budget {_fmt_ratio(rec.precision_at_budget)}, "
                            f"citation-coverage {_fmt_ratio(rec.citation_coverage)}"
                        )
                    if cq_parts:
                        lines.append(f"    - Context quality: {'; '.join(cq_parts)}")
                    lines.extend(_abbreviated_diff(rec.diff))
        lines.append("")

    # --- Context quality (issue #994) ------------------------------------
    # Aggregate per-arm context-pack precision/coverage. ``None`` (no rep in the
    # arm carried the metric — the live sandbox executor does not yet surface
    # them) renders as "n/a", DISTINCT from a measured 0.0. This section is the
    # home for the retrieval-quality signal the live eval was previously blind to.
    lines.append("## Context quality")
    lines.append("")
    lines.append(
        "Context-pack retrieval quality per arm (issue #994). ``n/a`` means the "
        "metric was not captured for this arm — the live sandbox executor does "
        "not yet plumb context-pack metadata out of the run — and is DISTINCT "
        "from a measured ``0.000``."
    )
    lines.append("")
    lines.append("| Arm | Mean precision@budget | Mean citation-coverage |")
    lines.append("| --- | ---: | ---: |")
    for r in reports:
        lines.append(
            f"| {r.arm} | {_fmt_ratio(r.mean_precision_at_budget)} "
            f"| {_fmt_ratio(r.mean_citation_coverage)} |"
        )
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Intrinsic-probe rendering (issue #943): routing cost-regret, retry lift,
# guardrail injection-corpus catch-rate. Rendering only — the probe MATH lives
# in ``agentrail.evals.probes`` (computed from recorded RunRecord/Verdict fields
# and the real guardrails), so the reporter never re-derives a number.
# ---------------------------------------------------------------------------


def render_probes_markdown(
    *,
    routing: Optional["RoutingRegretReport"] = None,
    retry: Optional["RetryLiftReport"] = None,
    guardrail: Optional["GuardrailCatchReport"] = None,
) -> str:
    """Render the three intrinsic probes as a markdown section (issue #943).

    Each probe is optional; a probe left ``None`` (e.g. no per-run records were
    collected for routing/retry) renders an honest "not available" line rather
    than a fabricated zero. Undefined ratios (empty denominators) render as
    ``n/a`` — never a fake 0.0, matching the rest of the reporter's honesty rail.
    """
    lines: List[str] = []
    lines.append("# AgentRail intrinsic probes")
    lines.append("")
    lines.append(
        "Measurements hidden tests cannot see (PRD §Intrinsic probes). All "
        "dollar figures route through the single-source pricing module; the "
        "guardrail catch-rate runs the REAL guardrails against a crafted "
        "injection corpus."
    )
    lines.append("")

    # --- Routing cost-regret (AC1) ---------------------------------------
    lines.append("## Routing cost-regret")
    lines.append("")
    lines.append(
        "Dollar regret = a solved run's cost minus the cheapest model that "
        "STILL SOLVED the same task across the run set. Unsolved runs and tasks "
        "no run solved contribute no regret."
    )
    lines.append("")
    if routing is None:
        lines.append(
            "_Not available: this report carries no per-run records (model/usage "
            "needed for regret)._"
        )
        lines.append("")
    else:
        lines.append(f"- Total routing cost-regret: {_fmt_usd(routing.total_regret_usd)}")
        if routing.per_arm:
            lines.append("- Per arm:")
            for a in routing.per_arm:
                lines.append(
                    f"  - {a.arm}: {_fmt_usd(a.regret_usd)} "
                    f"({a.solved_runs} solved run(s))"
                )
        lines.append("")

    # --- Retry lift (AC2) -------------------------------------------------
    lines.append("## Retry lift")
    lines.append("")
    lines.append(
        "Solve-rate lift attributable to retries = with-retry solve-rate minus "
        "first-attempt-only solve-rate. Wasted-retry cost = dollars spent on "
        "runs that retried but never solved."
    )
    lines.append("")
    if retry is None:
        lines.append(
            "_Not available: this report carries no per-run records (retry events "
            "needed for lift)._"
        )
        lines.append("")
    else:
        lines.append(
            f"- With-retry solve-rate: {_fmt_rate_pct(retry.with_retry_solve_rate)}"
        )
        lines.append(
            f"- First-attempt-only solve-rate: "
            f"{_fmt_rate_pct(retry.first_attempt_solve_rate)}"
        )
        lines.append(f"- Retry lift: {_fmt_rate_pct(retry.lift)}")
        lines.append(
            f"- Wasted-retry cost: {_fmt_usd(retry.wasted_retry_cost_usd)}"
        )
        lines.append("")

    # --- Guardrail catch-rate (AC3) --------------------------------------
    lines.append("## Guardrail injection-corpus catch-rate")
    lines.append("")
    lines.append(
        "Fraction of crafted VIOLATION cases (secret-in-diff, deleted-test) the "
        "REAL guardrails flagged. A clean case is included as a falsifier: a "
        "guardrail that flagged everything would surface it as a false positive."
    )
    lines.append("")
    if guardrail is None:
        lines.append("_Not available._")
        lines.append("")
    else:
        if guardrail.catch_rate is None:
            lines.append(
                "- Catch-rate: n/a (undefined — the corpus has no violation case)"
            )
        else:
            lines.append(
                f"- Catch-rate: {_fmt_pct(guardrail.catch_rate)} "
                f"({guardrail.caught} of {guardrail.violations} violations caught)"
            )
        lines.append("- Cases:")
        for c in guardrail.cases:
            if c.is_violation:
                status = "CAUGHT" if c.caught else "MISSED"
            else:
                status = "false positive" if c.flagged else "clean (not flagged)"
            lines.append(f"  - {c.kind} via {c.guardrail}: {status}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Routing/retry VALUE audit rendering (Finding 4 — measurement only).
#
# Distinct from the intrinsic probes above (efficiency: regret + lift). This
# section answers the blunt value question: did routing ever change the model
# from baseline (and if not, say so), and did retries flip failures into wins or
# just burn money? Rendering only — the attribution MATH lives in
# ``agentrail.evals.probes`` (routing_attribution / retry_attribution).
# ---------------------------------------------------------------------------


def render_routing_retry_audit_markdown(
    *,
    routing: Optional["RoutingAttributionReport"] = None,
    retry: Optional["RetryAttributionReport"] = None,
) -> str:
    """Render the routing/retry value audit as a markdown section (Finding 4).

    Each report is optional; ``None`` renders an honest "not available" line. The
    routing section makes the "had no chance to act" case EXPLICIT: when routing
    never diverged from the baseline model, the report says so rather than letting
    a flat zero read as "routing is worthless". Measurement only — nothing here
    changes a routing or retry decision.
    """
    lines: List[str] = []
    lines.append("# Routing/retry value audit")
    lines.append("")
    lines.append(
        "Measurement-only attribution (Finding 4): did the routing layer ever "
        "change the model from the arm's baseline/default, and did retries flip "
        "failures into wins or just burn cost? No live-loop behaviour is changed. "
        "All dollars route through the single-source pricing module."
    )
    lines.append("")

    # --- Routing $-delta vs baseline -------------------------------------
    lines.append("## Routing attribution (vs baseline model)")
    lines.append("")
    lines.append(
        "A run \"diverged\" when the resolved model differs from the run's "
        "recorded baseline/default model (the arm's pinned model it would have "
        "used had routing not acted)."
    )
    lines.append("")
    if routing is None:
        lines.append(
            "_Not available: this report carries no per-run records (baseline "
            "model needed for routing attribution)._"
        )
        lines.append("")
    elif routing.runs_with_baseline == 0:
        lines.append(
            "_Not available: no run recorded a baseline model, so routing could "
            "not be attributed._"
        )
        lines.append("")
    elif not routing.had_chance_to_act:
        # The explicit "had no chance to act" answer Finding 4 demands.
        lines.append(
            f"- Routing NEVER diverged from baseline across "
            f"{routing.runs_with_baseline} run(s) with a recorded baseline: it "
            f"had **no chance to act**, so it neither added nor destroyed value "
            f"here. A flat result is NOT a measured zero-value verdict."
        )
        lines.append("")
    else:
        lines.append(
            f"- Runs where routing changed the model: {routing.runs_diverged} "
            f"of {routing.runs_with_baseline} (baseline recorded)"
        )
        lines.append(
            f"- Runs that stayed on baseline (routing did nothing): "
            f"{routing.runs_at_baseline}"
        )
        lines.append(
            f"- Dollars spent on diverged runs: "
            f"{_fmt_usd(routing.spent_when_diverged_usd)}"
        )
        if routing.net_delta_usd is None:
            lines.append(
                "- Net $-delta vs baseline: n/a (no per-run baseline token usage "
                "exists to price a counterfactual — we never invent one)"
            )
        else:
            lines.append(
                f"- Net $-delta vs baseline: "
                f"{_fmt_signed_usd(routing.net_delta_usd)} "
                "(positive = routing spent more than baseline)"
            )
        lines.append("")

    # --- Retry win / burn -------------------------------------------------
    lines.append("## Retry attribution (wins vs burned cost)")
    lines.append("")
    lines.append(
        "A retry **win** is a run that retried and ended solved while its first "
        "attempt's gate did not pass (the retry flipped failure into success). A "
        "**burn** is a run that retried and ended unsolved (cost spent, no win)."
    )
    lines.append("")
    if retry is None:
        lines.append(
            "_Not available: this report carries no per-run records (retry events "
            "needed for retry attribution)._"
        )
        lines.append("")
    else:
        lines.append(f"- Runs that retried: {retry.runs_with_retries}")
        lines.append(
            f"- Retries that flipped failure into success (wins): {retry.wins}"
        )
        lines.append(
            f"- Retries that burned cost with no win (unsolved): {retry.burns}"
        )
        lines.append(
            f"- Cost burned by retries with no win: "
            f"{_fmt_usd(retry.cost_burned_usd)}"
        )
        lines.append("")

    return "\n".join(lines)


def default_reports_dir() -> Path:
    """Default directory for committed dated markdown reports."""
    return Path(__file__).resolve().parent / "reports"


def write_markdown_report(
    reports: Sequence[ArmReport],
    *,
    reports_dir: Optional[Path] = None,
    date: str,
    records: Optional[Sequence[RepetitionRecord]] = None,
) -> Path:
    """Render and write a dated markdown report; return the written path.

    File name is ``eval-report-<date>.md`` so reports are auditable in git and
    ordered chronologically.

    ``records`` (#994) is optional and forwarded to :func:`render_markdown`; when
    supplied, each FAILED run's diff + gate-failure reason + context-quality
    metrics are surfaced in the failure section. When ``None`` the report renders
    exactly as before (back-compatible).
    """
    base = Path(reports_dir) if reports_dir is not None else default_reports_dir()
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"eval-report-{date}.md"
    path.write_text(
        render_markdown(reports, generated_at=date, records=records),
        encoding="utf-8",
    )
    return path


# ---------------------------------------------------------------------------
# Postgres write (AC5) — injectable writer interface.
# ---------------------------------------------------------------------------

class MetricsWriter(Protocol):
    """Sink for per-arm eval metrics rows.

    Decoupled behind a Protocol so the reporter is unit-testable with an
    in-memory fake, and so the live Postgres surface can be supplied without
    the reporter knowing anything about HTTP, auth, or the schema.

    NOTE (#934 -> #942): there is no eval-metrics ingest route / Postgres
    schema yet — the existing ``/api/v1/ingest/runs`` and ``/cost-events``
    surfaces are run/cost shaped, not eval-arm shaped, and the drizzle schema
    + console read for eval arm metrics belong to issue #942 (migrations are
    TS-owned and must land in the migration journal). The reporter therefore
    produces the rows and hands them to whatever writer is injected; the
    default ``HttpMetricsWriter`` is a thin client awaiting that route, and is
    a deliberate no-op (returns False) until #942 lands so it never silently
    claims a false-green persist.
    """

    def write_arm_metrics(self, rows: Sequence[dict]) -> bool:
        ...


def arm_metric_rows(reports: Sequence[ArmReport], *, run_id: str) -> List[dict]:
    """Flatten per-arm reports into Postgres-ready rows.

    Each row carries the SAME numbers the markdown surfaces, so the console and
    the committed report can never disagree.
    """
    return [
        {
            "run_id": run_id,
            "arm": r.arm,
            "repetitions": r.repetitions,
            "solved_count": r.solved_count,
            "failed_count": r.failed_count,
            "solve_rate": r.solve_rate,
            "spread": r.spread,
            "total_input_tokens": r.total_input_tokens,
            "total_output_tokens": r.total_output_tokens,
            "total_cache_tokens": r.total_cache_tokens,
            "total_cache_creation_tokens": r.total_cache_creation_tokens,
            "total_tokens": r.total_tokens,
            "total_cost_usd": r.total_cost_usd,
            "dollars_per_solved": r.dollars_per_solved,
            # Wall-time per task (#980): mean + total seconds, so the console
            # shows the same wall-time the markdown does (never disagree).
            "mean_wall_time_s": r.mean_wall_time_s,
            "total_wall_time_s": r.total_wall_time_s,
            # Objective Gate false-green probe (#940). None (not 0.0) for the
            # undefined-denominator case so the console can render it honestly.
            "gate_passed_count": r.gate_passed_count,
            "false_green_count": r.false_green_count,
            "false_green_rate": r.false_green_rate,
            # Context-pack quality (#994). None (not 0.0) when no rep in the arm
            # carried the metric, so the console renders "n/a" honestly and never
            # disagrees with the markdown's Context quality section.
            "mean_precision_at_budget": r.mean_precision_at_budget,
            "mean_citation_coverage": r.mean_citation_coverage,
            # Difficulty-stratified breakdown (#941) so the console can show the
            # same per-stratum numbers the markdown does (never disagree).
            "strata": [
                {
                    "difficulty": s.difficulty,
                    "repetitions": s.repetitions,
                    "solved_count": s.solved_count,
                    "failed_count": s.failed_count,
                    "solve_rate": s.solve_rate,
                    "total_cost_usd": s.total_cost_usd,
                    "dollars_per_solved": s.dollars_per_solved,
                }
                for s in r.strata
            ],
        }
        for r in reports
    ]


def layer_delta_rows(deltas: Sequence[LayerDelta], *, run_id: str) -> List[dict]:
    """Flatten per-layer ablation deltas into persistence-ready rows (#939).

    Per-layer (cross-arm) shape, distinct from the per-arm ``arm_metric_rows``:
    each row carries the layer, its source solve rates, the ``full - ablation``
    delta (``None`` when undefined), and the flag the markdown surfaces — so the
    console and the committed report can never disagree on which layers are
    candidates to fix or remove.
    """
    return [
        {
            "run_id": run_id,
            "layer": d.layer,
            "full_solve_rate": d.full_solve_rate,
            "ablation_solve_rate": d.ablation_solve_rate,
            "delta": d.delta,
            "earns_place": d.earns_place,
            "flagged": d.flagged,
        }
        for d in deltas
    ]


def write_reports(
    reports: Sequence[ArmReport],
    writer: MetricsWriter,
    *,
    run_id: str,
) -> bool:
    """Write per-arm metric rows to Postgres via *writer*.

    Returns whatever the writer reports (True on success). The reporter builds
    the rows; persistence policy (HTTP, auth, non-fatal swallowing) lives in
    the injected writer, matching the existing run_register/cost_push pattern.
    """
    rows = arm_metric_rows(reports, run_id=run_id)
    return writer.write_arm_metrics(rows)


class HttpMetricsWriter:
    """Default writer: posts per-arm metric rows to the linked AgentRail server.

    Mirrors the existing non-fatal HTTP-ingest pattern
    (``agentrail.afk.run_register`` / ``agentrail.run.cost_push``): resolve the
    workspace link, POST, swallow every failure.

    LIVE (#942): the eval-metrics ingest route
    (``POST /api/v1/ingest/eval-arm-metrics``) and its drizzle schema exist, so
    this writer now POSTs the reporter's rows to it. Failure is non-fatal — the
    offline eval (markdown report) always stands on its own:

    - not linked (no ``server.json`` / no ``AGENTRAIL_SERVER_*`` env) → ``False``,
      no network call;
    - no rows → ``False`` (nothing to persist, never a spurious success);
    - any HTTP / network exception → ``False`` (swallowed), never raises;
    - only a real HTTP 202 from the ingest route → ``True``.

    The workspace is derived server-side from the bearer API key (exactly like
    cost_push), so the rows themselves carry no workspace/repository id.
    """

    _ENDPOINT = "/api/v1/ingest/eval-arm-metrics"  # owned by #942

    def __init__(self, target: Path) -> None:
        self._target = Path(target)

    def write_arm_metrics(self, rows: Sequence[dict]) -> bool:
        if not rows:
            return False
        # Lazy imports keep the reporter's pure aggregation/rendering free of
        # HTTP/link dependencies (matches the run_register/cost_push split).
        import json
        import urllib.request

        from agentrail.context.snapshot_push import load_link

        link = load_link(self._target)
        if link is None:
            # Honest: not linked to a server. Do not claim a persist.
            return False
        body = json.dumps(list(rows)).encode("utf-8")
        req = urllib.request.Request(
            f"{link['base_url']}{self._ENDPOINT}",
            data=body,
            headers={
                "Authorization": f"Bearer {link['api_key']}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return int(resp.status) == 202
        except Exception:  # noqa: BLE001 — non-fatal by design
            return False
