"""Offline packer-tightening A/B, gated through the EXISTING two-set regression
gate (issue #1225 AC2).

Position in the harness:

    tightened_packer_arms() -> [full(), tightened_packer_arm()]
                                            |
                                            v
                                      run_spine(...)  -->  SpineResult.repetitions
                                            |
                                            v
                        regression_gate.evaluate_regression(...)  -->  RegressionGateReport

This module owns ONE thing: gluing the already-declared A/B pair (``full`` vs
``full-plus-tightened_packer``, :mod:`agentrail.evals.arms`) to the already-built
spine (:func:`agentrail.evals.spine.run_spine`) and the already-built two-set
gate (:func:`agentrail.evals.regression_gate.evaluate_regression`). It adds no
new statistics, no new arm-execution logic, and no new gate — everything it
touches is imported from its canonical home, exactly like
:mod:`agentrail.evals.canary` does for the nightly canary.

The comparison this produces answers exactly the AC2 question: does a
genuinely TIGHTER packer (the #1096 adaptive cutoff, ON, plus a token budget
half the default — see :data:`agentrail.evals.arms.TIGHTENED_PACKER_MAX_TOKENS`)
hold solve-rate while lowering $/solved, at a SMALLER context budget than the
current packer uses? The paired, CI-based verdict (GREEN / RED /
INSUFFICIENT_REPS) is entirely the regression gate's — this module never
computes or interprets a verdict itself.

Diagnostic-only, like every other precision-adjacent metric in this codebase
(#1037 AC5, #1225 AC3): this A/B's OUTPUT is a report a human reads, not a
value read by any pass/fail path in ``agentrail.guardrails``. Running it never
gates a run; it only ever informs a decision to later change the packer's
shipped default (mirroring how the #1096 cutoff and #1044 rerank A/Bs already
work).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

from agentrail.context.retrieval import RETRIEVAL_MAX_TOKENS
from agentrail.evals.arms import (
    TIGHTENED_PACKER_MAX_TOKENS,
    Arm,
    full,
    tightened_packer_arm,
)
from agentrail.evals.regression_gate import (
    GateThresholds,
    RegressionGateReport,
    evaluate_regression,
    render_gate_markdown,
)
from agentrail.evals.reporter import MetricsWriter
from agentrail.evals.runner import AgentExecutor, SandboxAgentExecutor
from agentrail.evals.spine import HiddenTestRunner, SpineConfig, SpineResult, run_spine


@dataclass(frozen=True)
class PackerTighteningResult:
    """Observable output of one packer-tightening A/B run."""

    spine_result: SpineResult
    gate_report: RegressionGateReport
    baseline_budget: int
    tightened_budget: int


def run_packer_tightening_ab(
    *,
    reps: int = 5,
    task_filter: Optional[Sequence[str]] = None,
    corpus_root: Optional[Path] = None,
    concurrency: int = 1,
    include_held_out: bool = False,
    reports_dir: Optional[Path] = None,
    date: Optional[str] = None,
    run_id: Optional[str] = None,
    thresholds: Optional[GateThresholds] = None,
    # --- injectable seams (default to production) ------------------------
    baseline_arm: Optional[Arm] = None,
    candidate_arm: Optional[Arm] = None,
    executor: Optional[AgentExecutor] = None,
    hidden_test_runner: Optional[HiddenTestRunner] = None,
    metrics_writer: Optional[MetricsWriter] = None,
    spine_runner: Callable[..., SpineResult] = run_spine,
) -> PackerTighteningResult:
    """Run the packer-tightening A/B and gate it through the two-set regression gate.

    Drives the SAME spine every other eval arm uses
    (:func:`agentrail.evals.spine.run_spine`) over exactly two arms — the
    current packer (:func:`agentrail.evals.arms.full`) and the tightened
    variant (:func:`agentrail.evals.arms.tightened_packer_arm`, cutoff ON at a
    smaller token budget) — then feeds the resulting
    :class:`~agentrail.evals.reporter.RepetitionRecord` list straight into
    :func:`agentrail.evals.regression_gate.evaluate_regression`, paired by
    task, exactly as every other regression-gate comparison in this codebase
    is scored. No new statistics: the verdict (GREEN / RED /
    INSUFFICIENT_REPS), the per-task paired deltas, and the CI/power evidence
    are 100% the gate's own output.

    Every heavy dependency is injectable (mirrors
    :func:`agentrail.evals.canary.run_canary`) so the wiring itself is
    unit-testable with faithful fakes — no network, no real agent, no cost —
    while the DEFAULTS are exactly what a real run needs
    (:class:`~agentrail.evals.runner.SandboxAgentExecutor` +
    :class:`~agentrail.evals.hidden_tests.ProductionHiddenTestRunner`).

    ``baseline_arm`` / ``candidate_arm`` default to :func:`full` /
    :func:`tightened_packer_arm` — override only for tests that need a
    different pair to still exercise this exact wiring.
    """
    resolved_baseline = baseline_arm if baseline_arm is not None else full()
    resolved_candidate = candidate_arm if candidate_arm is not None else tightened_packer_arm()

    resolved_executor = executor if executor is not None else SandboxAgentExecutor()
    resolved_hidden_runner = hidden_test_runner
    if resolved_hidden_runner is None:
        from agentrail.evals.hidden_tests import ProductionHiddenTestRunner

        resolved_hidden_runner = ProductionHiddenTestRunner()

    config = SpineConfig(
        arms=[resolved_baseline, resolved_candidate],
        reps=reps,
        task_filter=task_filter,
        corpus_root=corpus_root,
        include_held_out=include_held_out,
        concurrency=concurrency,
    )

    spine_result = spine_runner(
        config,
        executor=resolved_executor,
        hidden_test_runner=resolved_hidden_runner,
        metrics_writer=metrics_writer,
        reports_dir=reports_dir,
        date=date,
        run_id=run_id,
    )

    gate_report = evaluate_regression(
        spine_result.repetitions,
        baseline_arm=resolved_baseline.name,
        candidate_arm=resolved_candidate.name,
        thresholds=thresholds,
    )

    return PackerTighteningResult(
        spine_result=spine_result,
        gate_report=gate_report,
        baseline_budget=RETRIEVAL_MAX_TOKENS,
        tightened_budget=(
            resolved_candidate.retrieval_max_tokens
            if resolved_candidate.retrieval_max_tokens is not None
            else TIGHTENED_PACKER_MAX_TOKENS
        ),
    )


def render_packer_tightening_markdown(result: PackerTighteningResult) -> str:
    """Render :class:`PackerTighteningResult` as markdown (AC2 evidence).

    The header states the budgets being compared (the piece the generic
    :func:`agentrail.evals.regression_gate.render_gate_markdown` has no notion
    of); the body IS that function's own rendering, unmodified — this module
    adds no new report format, only a one-line frame around the reused one.
    """
    lines = [
        "# Packer-tightening A/B (#1225 AC2)",
        "",
        f"- Current packer (`{result.gate_report.baseline_arm}`) token budget: "
        f"{result.baseline_budget}",
        f"- Tightened packer (`{result.gate_report.candidate_arm}`) token budget: "
        f"{result.tightened_budget}",
        "",
        render_gate_markdown(result.gate_report),
    ]
    return "\n".join(lines)


__all__ = [
    "PackerTighteningResult",
    "run_packer_tightening_ab",
    "render_packer_tightening_markdown",
]
