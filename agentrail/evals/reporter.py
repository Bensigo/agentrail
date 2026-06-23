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

from agentrail.evals.arms import LAYER_NAMES
from agentrail.evals.pricing_adapter import usage_cost


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


# ---------------------------------------------------------------------------
# Per-arm aggregate
# ---------------------------------------------------------------------------

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

    # Headline cost metric: dollars per *solved* task. Undefined (None) when
    # nothing solved — the AC3 no-divide-by-zero guard.
    dollars_per_solved = (total_cost / solved_count) if solved_count else None

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
        gate_passed_count=gate_passed_count,
        false_green_count=false_green_count,
        false_green_rate=false_green_rate,
        per_task_solve_rate=per_task_solve_rate,
    )


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
# Markdown rendering (honesty rails: failures, ties, spread — not only wins)
# ---------------------------------------------------------------------------

_UNDEFINED = "n/a"


def _fmt_usd(value: Optional[float]) -> str:
    if value is None:
        return _UNDEFINED
    return f"${value:.4f}"


def _fmt_pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def _fmt_rate_pct(value: Optional[float]) -> str:
    """Percentage formatter that preserves the None-vs-0.0 distinction.

    ``None`` (undefined denominator) renders as ``n/a``; ``0.0`` renders as
    ``0.0%`` — so a never-gate-passed arm never masquerades as a clean one.
    """
    if value is None:
        return _UNDEFINED
    return _fmt_pct(value)


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


def render_markdown(reports: Sequence[ArmReport], *, generated_at: str) -> str:
    """Render the per-arm reports as a markdown document.

    Always reports failures, ties, and spread alongside wins (CONTEXT.md
    honesty rail). Uses the project's domain language: solve-rate,
    dollars-per-solved-task, spread.
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
        "False-green rate | Total tokens | Total cost | Dollars-per-solved-task |"
    )
    lines.append(
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    )
    for r in reports:
        lines.append(
            f"| {r.arm} | {r.repetitions} | {r.solved_count} | {r.failed_count} "
            f"| {_fmt_pct(r.solve_rate)} | {r.spread:.4f} "
            f"| {_fmt_rate_pct(r.false_green_rate)} "
            f"| {r.total_tokens} | {_fmt_usd(r.total_cost_usd)} "
            f"| {_fmt_usd(r.dollars_per_solved)} |"
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
) -> Path:
    """Render and write a dated markdown report; return the written path.

    File name is ``eval-report-<date>.md`` so reports are auditable in git and
    ordered chronologically.
    """
    base = Path(reports_dir) if reports_dir is not None else default_reports_dir()
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"eval-report-{date}.md"
    path.write_text(render_markdown(reports, generated_at=date), encoding="utf-8")
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
            # Objective Gate false-green probe (#940). None (not 0.0) for the
            # undefined-denominator case so the console can render it honestly.
            "gate_passed_count": r.gate_passed_count,
            "false_green_count": r.false_green_count,
            "false_green_rate": r.false_green_rate,
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

    DEFERRED TO #942: the eval-metrics ingest route + drizzle schema do not
    exist yet. Rather than POST to a non-existent endpoint and pretend it
    persisted, this writer is currently a guarded no-op that returns ``False``
    (not persisted). When #942 lands the ingest route and migration, fill in
    the ``endpoint`` and flip ``_ENABLED``; the reporter contract above does
    not change.
    """

    _ENABLED = False
    _ENDPOINT = "/api/v1/ingest/eval-arm-metrics"  # owned by #942

    def __init__(self, target: Path) -> None:
        self._target = Path(target)

    def write_arm_metrics(self, rows: Sequence[dict]) -> bool:  # pragma: no cover
        if not self._ENABLED:
            # Honest: the live surface is not built (#942). Do not claim success.
            return False
        # When #942 lands, POST `rows` (+ repository_id from load_link) to
        # self._ENDPOINT here, returning True only on HTTP 202 — exactly like
        # run_register/cost_push. Left unimplemented on purpose: see class doc.
        raise NotImplementedError(
            "eval-metrics ingest route is owned by issue #942"
        )
