"""Tests for the rerank-arm head-to-head delta in the reporter (#1029 AC3).

The rerank arm (``full-minus-rerank``) is a leave-one-out ablation of ``full``.
AC3 asks the eval report to show the ``full`` vs ``full-minus-rerank`` DELTA on
the headline metrics: solve-rate and dollars-per-solved (both from the per-arm
``ArmReport``) AND context-pack precision/recall (the #1029 AC2 ground-truth
scorer, threaded in from :mod:`agentrail.evals.pack_scorer`).

Every delta is ``full-minus-rerank`` minus ``full`` on the SAME run set, so each
is falsifiable — turning rerank OFF can make any metric come back better OR
worse. The whole thing is ``None`` (undefined, never fabricated) when either arm
is absent; each metric delta is ``None`` when either side's value is undefined —
preserving the codebase-wide None-vs-measured-0.0 invariant.
"""

from __future__ import annotations

import pytest

from agentrail.evals.pack_scorer import ArmPackScore
from agentrail.evals.reporter import (
    ArmReport,
    RerankDelta,
    rerank_delta,
)


def _arm_report(
    arm: str,
    *,
    solve_rate: float,
    dollars_per_solved,
) -> ArmReport:
    """A minimal ArmReport carrying only the fields the rerank delta reads."""
    return ArmReport(
        arm=arm,
        repetitions=10,
        solved_count=5,
        failed_count=5,
        solve_rate=solve_rate,
        spread=0.0,
        total_input_tokens=0,
        total_output_tokens=0,
        total_cache_tokens=0,
        total_cache_creation_tokens=0,
        total_tokens=0,
        total_cost_usd=1.0,
        dollars_per_solved=dollars_per_solved,
    )


def _pack_score(
    arm: str,
    *,
    mean_precision,
    mean_recall,
) -> ArmPackScore:
    return ArmPackScore(
        arm=arm,
        pack_count=3,
        mean_precision=mean_precision,
        mean_recall=mean_recall,
        defined_precision_count=3,
        defined_recall_count=3,
    )


# ---------------------------------------------------------------------------
# Presence / absence
# ---------------------------------------------------------------------------


def test_delta_is_none_when_full_arm_absent():
    """No ``full`` arm -> undefined (None), never a fabricated row."""
    reports = [
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]
    assert rerank_delta(reports) is None


def test_delta_is_none_when_ablation_arm_absent():
    """No ``full-minus-rerank`` arm -> undefined (None)."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
    ]
    assert rerank_delta(reports) is None


# ---------------------------------------------------------------------------
# Solve-rate + dollars-per-solved deltas (from ArmReport)
# ---------------------------------------------------------------------------


def test_solve_rate_delta_is_ablation_minus_full():
    """solve_rate_delta = full-minus-rerank minus full (negative = rerank helped)."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]

    delta = rerank_delta(reports)

    assert isinstance(delta, RerankDelta)
    assert delta.full_solve_rate == 0.6
    assert delta.ablation_solve_rate == 0.4
    assert delta.solve_rate_delta == pytest.approx(-0.2)


def test_dollars_per_solved_delta_is_ablation_minus_full():
    """dollars_per_solved_delta = full-minus-rerank minus full (positive = rerank cheaper)."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.40),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.55),
    ]

    delta = rerank_delta(reports)

    assert delta.full_dollars_per_solved == 0.40
    assert delta.ablation_dollars_per_solved == 0.55
    assert delta.dollars_per_solved_delta == pytest.approx(0.15)


def test_dollars_per_solved_delta_is_none_when_an_arm_never_solved():
    """Undefined $/solved on either side -> None delta, never a fabricated number."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.40),
        _arm_report("full-minus-rerank", solve_rate=0.0, dollars_per_solved=None),
    ]

    delta = rerank_delta(reports)

    assert delta.ablation_dollars_per_solved is None
    assert delta.dollars_per_solved_delta is None


# ---------------------------------------------------------------------------
# Precision / recall deltas (threaded in from the AC2 pack scorer)
# ---------------------------------------------------------------------------


def test_precision_recall_deltas_from_pack_scores():
    """Precision/recall deltas come from the AC2 pack-score aggregate, ablation minus full."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]
    pack_scores = [
        _pack_score("full", mean_precision=0.80, mean_recall=0.90),
        _pack_score("full-minus-rerank", mean_precision=0.50, mean_recall=0.60),
    ]

    delta = rerank_delta(reports, pack_scores=pack_scores)

    assert delta.full_mean_precision == 0.80
    assert delta.ablation_mean_precision == 0.50
    assert delta.precision_delta == pytest.approx(-0.30)
    assert delta.full_mean_recall == 0.90
    assert delta.ablation_mean_recall == 0.60
    assert delta.recall_delta == pytest.approx(-0.30)


def test_precision_recall_none_when_pack_scores_not_supplied():
    """Without pack scores, precision/recall are undefined (None) — never fabricated 0.0."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]

    delta = rerank_delta(reports)

    assert delta.full_mean_precision is None
    assert delta.ablation_mean_precision is None
    assert delta.precision_delta is None
    assert delta.full_mean_recall is None
    assert delta.ablation_mean_recall is None
    assert delta.recall_delta is None


def test_precision_delta_none_when_one_arm_precision_undefined():
    """A None precision on either side -> None delta (undefined, not 0.0)."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]
    pack_scores = [
        _pack_score("full", mean_precision=None, mean_recall=0.9),
        _pack_score("full-minus-rerank", mean_precision=0.5, mean_recall=0.6),
    ]

    delta = rerank_delta(reports, pack_scores=pack_scores)

    assert delta.full_mean_precision is None
    assert delta.precision_delta is None
    # recall is defined on both sides, so its delta is still computed.
    assert delta.recall_delta == pytest.approx(-0.30)


def test_precision_recall_none_when_pack_scores_omit_an_arm():
    """A pack-score aggregate missing an arm leaves that metric undefined (None)."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]
    pack_scores = [
        _pack_score("full", mean_precision=0.8, mean_recall=0.9),
        # full-minus-rerank pack score missing entirely
    ]

    delta = rerank_delta(reports, pack_scores=pack_scores)

    assert delta.full_mean_precision == 0.8
    assert delta.ablation_mean_precision is None
    assert delta.precision_delta is None


# ---------------------------------------------------------------------------
# Immutability
# ---------------------------------------------------------------------------


def test_rerank_delta_is_frozen():
    """RerankDelta is immutable — a computed delta cannot be mutated into another verdict."""
    reports = [
        _arm_report("full", solve_rate=0.6, dollars_per_solved=0.4),
        _arm_report("full-minus-rerank", solve_rate=0.4, dollars_per_solved=0.5),
    ]
    delta = rerank_delta(reports)
    with pytest.raises(Exception):
        delta.solve_rate_delta = 0.0  # type: ignore[misc]
