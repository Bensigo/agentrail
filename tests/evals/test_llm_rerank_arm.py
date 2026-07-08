"""Tests for the LLM-rerank A/B arm and its fileNDCG OFF-vs-ON comparison (#1044 AC2).

The LLM listwise rerank (agentrail/context/llm_rerank.py) is an OPT-IN,
model-dependent layer that is NOT part of ``full`` — like the new-flow layers it
is A/B'd as a PLUS arm (``full`` vs ``full-plus-llm_rerank``). These tests fix
the arm shape, the layer→env mapping, and that the OFF-vs-ON comparison runs and
reports a ``fileNDCG`` field per arm.

Honest scope (matching the honest note in ``score_llm_rerank_ndcg``): the REAL
fileNDCG delta on the current fixtures is ~0 (most fixtures are already
rank-saturated at nDCG 1.0 — harder-rank fixtures are #1107 — and the rerank only
fires when a headless ``claude`` binary is available). So these tests assert the
field EXISTS and the arm TOGGLES the seam, never a specific lift; the comparison
math is exercised with an injected fake evaluator, not a fabricated real delta.
"""
from __future__ import annotations

import os

import pytest

from agentrail.evals.arms import (
    LLM_RERANK_LAYER,
    PINNED_TEMPERATURE,
    baseline,
    full,
    llm_rerank_arm,
    llm_rerank_arms,
)
from agentrail.evals.pack_scoring import score_llm_rerank_ndcg
from agentrail.evals.runner import _arm_env

_ENV = "AGENTRAIL_CONTEXT_LLM_RERANK"


# ---------------------------------------------------------------------------
# Arm registration + opt-in shape
# ---------------------------------------------------------------------------


def test_llm_rerank_arm_is_full_plus_the_opt_in_layer() -> None:
    arm = llm_rerank_arm()
    assert arm.name == f"full-plus-{LLM_RERANK_LAYER}"
    # Every base AgentRail layer stays ON (a strict superset of ``full``).
    assert arm.layers == full().layers
    # The opt-in layer rides extra_layers, switched ON.
    assert dict(arm.extra_layers) == {LLM_RERANK_LAYER: True}


def test_llm_rerank_arms_pair_is_full_off_then_full_plus_on() -> None:
    off, on = llm_rerank_arms()
    assert off.name == "full"
    assert on.name == f"full-plus-{LLM_RERANK_LAYER}"
    # OFF arm carries no llm_rerank extra layer (default-OFF), ON arm sets it.
    assert dict(off.extra_layers) == {}
    assert on.extra_layers.get(LLM_RERANK_LAYER) is True


def test_llm_rerank_arm_holds_model_and_temperature_fixed_to_full() -> None:
    """The A/B toggles ONLY the layer — model/temperature match ``full``."""
    f, arm = full(), llm_rerank_arm()
    assert arm.model == f.model
    assert arm.temperature == f.temperature == PINNED_TEMPERATURE


def test_full_and_baseline_do_not_carry_the_llm_rerank_layer() -> None:
    for arm in (full(), baseline()):
        assert LLM_RERANK_LAYER not in arm.extra_layers


# ---------------------------------------------------------------------------
# Layer → env mapping (the runner bridge, single source of truth)
# ---------------------------------------------------------------------------


def test_arm_env_maps_llm_rerank_layer_to_the_context_flag() -> None:
    """The ON arm sets AGENTRAIL_CONTEXT_LLM_RERANK=1; ``full``/baseline do not."""
    assert _arm_env(llm_rerank_arm())[_ENV] == "1"
    assert _ENV not in _arm_env(full())
    assert _ENV not in _arm_env(baseline())


# ---------------------------------------------------------------------------
# OFF-vs-ON comparison reports fileNDCG per arm and toggles the seam
# ---------------------------------------------------------------------------


def test_off_vs_on_comparison_reports_filendcg_per_arm_and_toggles_the_seam(tmp_path) -> None:
    """The comparison runs both arms, reports a fileNDCG per arm, and the seam the
    live stage reads is genuinely toggled (OFF sees "0", ON sees "1")."""
    seen: list = []

    def fake_evaluate(root, fixture_file):
        flag = os.environ.get(_ENV)
        seen.append(flag)
        # Distinct per-arm values so we prove the plumbing carries per-arm
        # fileNDCG and computes the delta — NOT a claim of a real lift.
        ndcg = 0.90 if flag == "1" else 0.80
        return {"summary": {"means": {"fileNDCG": ndcg}}}

    result = score_llm_rerank_ndcg(
        tmp_path, tmp_path / "retrieval-fixtures.json", evaluate=fake_evaluate
    )

    # The stage's env seam was toggled across the two arms.
    assert seen == ["0", "1"]

    # A fileNDCG field is reported per arm.
    arms = result["arms"]
    assert len(arms) == 2
    for entry in arms:
        assert "fileNDCG" in entry
    off = next(a for a in arms if not a["llmRerank"])
    on = next(a for a in arms if a["llmRerank"])
    assert off["arm"] == "full" and off["fileNDCG"] == 0.80
    assert on["arm"] == f"full-plus-{LLM_RERANK_LAYER}" and on["fileNDCG"] == 0.90
    assert result["fileNDCGDelta"] == pytest.approx(0.10, rel=1e-12)


def test_rank_saturated_fixtures_yield_a_zero_delta(tmp_path) -> None:
    """The HONEST current-fixtures case: both arms saturate at nDCG 1.0 → delta 0.

    Guards against fabricating a lift — an equal-fileNDCG A/B must read as 0.0,
    not a positive number."""

    def fake_evaluate(root, fixture_file):
        return {"summary": {"means": {"fileNDCG": 1.0}}}

    result = score_llm_rerank_ndcg(
        tmp_path, tmp_path / "fixtures.json", evaluate=fake_evaluate
    )
    assert [a["fileNDCG"] for a in result["arms"]] == [1.0, 1.0]
    assert result["fileNDCGDelta"] == 0.0


def test_missing_filendcg_yields_none_delta_never_a_fake_zero(tmp_path) -> None:
    """When a report lacks fileNDCG (e.g. no index → skipped fixtures) the delta is
    None (undefined), never a fabricated 0.0."""

    def fake_evaluate(root, fixture_file):
        return {"summary": {"means": {}}}  # no fileNDCG surfaced

    result = score_llm_rerank_ndcg(
        tmp_path, tmp_path / "fixtures.json", evaluate=fake_evaluate
    )
    assert all(a["fileNDCG"] is None for a in result["arms"])
    assert result["fileNDCGDelta"] is None
