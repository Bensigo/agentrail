"""Tests for the offline pack-vs-answer-key precision/recall scorer (#1029 AC2).

This is a GROUND-TRUTH scorer, distinct from
``agentrail.context.pack_quality.compute_pack_quality`` (a ground-truth-FREE
token-share proxy). It intersects the paths a context pack CITED with the
corpus task's ``requiredContext`` answer key:

    precision = |cited ∩ required| / |cited|
    recall    = |cited ∩ required| / |required|

Set-based over paths, deterministic, no IO. Both ratios are ``None`` (undefined)
when their denominator is empty — an empty pack has no precision, an empty
answer key has no recall — and ``None`` stays distinct from a measured ``0.0``.
"""

from __future__ import annotations

import pytest

from agentrail.evals.pack_scorer import (
    PackScore,
    ArmPackScore,
    pack_precision_recall,
    aggregate_pack_scores,
)


# ---------------------------------------------------------------------------
# Per-pack precision/recall
# ---------------------------------------------------------------------------


def test_perfect_pack_scores_precision_and_recall_one():
    """A pack that cites exactly the required set scores 1.0 / 1.0."""
    required = ["a.py", "b.py", "c.py"]
    cited = ["a.py", "b.py", "c.py"]

    score = pack_precision_recall(cited, required)

    assert score.precision == 1.0
    assert score.recall == 1.0
    assert score.intersection == 3
    assert score.cited_count == 3
    assert score.required_count == 3


def test_partial_overlap_computes_set_based_ratios():
    """Precision = hits/cited; recall = hits/required, over the path SETS."""
    required = ["a.py", "b.py", "c.py", "d.py"]  # 4 required
    cited = ["a.py", "b.py", "x.py"]  # 3 cited, 2 hits

    score = pack_precision_recall(cited, required)

    assert score.intersection == 2
    assert score.precision == pytest.approx(2 / 3)
    assert score.recall == pytest.approx(2 / 4)


def test_duplicate_cited_paths_are_deduplicated():
    """Cited paths are a SET — duplicates never inflate the denominator."""
    required = ["a.py", "b.py"]
    cited = ["a.py", "a.py", "a.py"]  # one distinct hit

    score = pack_precision_recall(cited, required)

    assert score.cited_count == 1
    assert score.intersection == 1
    assert score.precision == 1.0  # 1 hit / 1 distinct cited
    assert score.recall == pytest.approx(1 / 2)


def test_no_overlap_scores_zero_not_none():
    """A pack that cites nothing required scores a MEASURED 0.0, not None."""
    required = ["a.py", "b.py"]
    cited = ["x.py", "y.py"]

    score = pack_precision_recall(cited, required)

    assert score.precision == 0.0
    assert score.recall == 0.0
    assert score.precision is not None
    assert score.recall is not None


def test_empty_pack_has_undefined_precision_but_zero_recall():
    """An empty pack: precision is undefined (0/0 -> None); recall is 0.0."""
    required = ["a.py", "b.py"]
    cited = []

    score = pack_precision_recall(cited, required)

    assert score.precision is None  # 0 cited -> undefined, not 0.0
    assert score.recall == 0.0  # 0 hits / 2 required -> measured zero
    assert score.cited_count == 0


def test_empty_answer_key_has_undefined_recall():
    """An empty required set: recall is undefined (0/0 -> None)."""
    required = []
    cited = ["a.py"]

    score = pack_precision_recall(cited, required)

    assert score.recall is None  # 0 required -> undefined, not 0.0
    assert score.precision == 0.0  # 0 hits / 1 cited -> measured zero


def test_pack_score_is_frozen():
    """PackScore is immutable — a computed score cannot be mutated after the fact."""
    score = pack_precision_recall(["a.py"], ["a.py"])
    with pytest.raises(Exception):
        score.precision = 0.0  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Per-arm aggregate
# ---------------------------------------------------------------------------


def test_aggregate_averages_defined_scores_per_arm():
    """Per-arm mean precision/recall averages only the DEFINED per-pack scores."""
    scores = {
        "full": [
            pack_precision_recall(["a.py", "b.py"], ["a.py", "b.py"]),  # 1.0 / 1.0
            pack_precision_recall(["a.py", "x.py"], ["a.py", "b.py"]),  # 0.5 / 0.5
        ],
    }

    agg = aggregate_pack_scores(scores)

    assert len(agg) == 1
    full = agg[0]
    assert full.arm == "full"
    assert full.pack_count == 2
    assert full.mean_precision == pytest.approx(0.75)
    assert full.mean_recall == pytest.approx(0.75)


def test_aggregate_skips_none_scores_in_the_mean():
    """Undefined (None) per-pack scores are excluded from the mean, not counted as 0."""
    scores = {
        "full": [
            pack_precision_recall(["a.py"], ["a.py"]),  # precision 1.0
            pack_precision_recall([], ["a.py"]),  # precision None (empty pack)
        ],
    }

    agg = aggregate_pack_scores(scores)
    full = agg[0]

    # Only the one defined precision (1.0) contributes; the None is skipped.
    assert full.mean_precision == 1.0
    assert full.defined_precision_count == 1
    assert full.pack_count == 2


def test_aggregate_all_none_precision_yields_none_mean():
    """If every pack's precision is undefined, the arm mean is None (not 0.0)."""
    scores = {
        "empty-arm": [
            pack_precision_recall([], ["a.py"]),  # precision None
            pack_precision_recall([], ["b.py"]),  # precision None
        ],
    }

    agg = aggregate_pack_scores(scores)
    arm = agg[0]

    assert arm.mean_precision is None
    assert arm.defined_precision_count == 0
    # recall is defined (0.0) for both, so the recall mean is a measured 0.0.
    assert arm.mean_recall == 0.0


def test_aggregate_orders_arms_deterministically():
    """Arms come back in a stable (sorted) order for a deterministic report."""
    scores = {
        "full-minus-rerank": [pack_precision_recall(["a.py"], ["a.py"])],
        "full": [pack_precision_recall(["a.py"], ["a.py"])],
    }

    agg = aggregate_pack_scores(scores)

    assert [a.arm for a in agg] == ["full", "full-minus-rerank"]
