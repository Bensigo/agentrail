"""Tests for the cutoff / symbol-packing / gather A/B arms (#1023; #1049 PR1).

Three flag-gated, default-OFF context/pipeline layers are wired as opt-in PLUS
arms — exactly like the LLM-rerank arm (#1044): each is ``full`` PLUS one layer
switched ON via ``extra_layers``, paired against plain ``full`` (layer OFF), and
the runner's ``_arm_env`` bridges the layer flag to the ONE env var its live
resolver reads:

    cutoff          -> AGENTRAIL_CONTEXT_PACK_CUTOFF=1   (resolve_pack_cutoff)
    symbol_packing  -> AGENTRAIL_CONTEXT_SYMBOL_PACKING=1 (symbol_packing_enabled)
    gather          -> AGENTRAIL_JIT_GATHER=1 + AGENTRAIL_EVAL_GATHER_MODEL=<cheap>
                       (jit_gather_enabled + resolve_gather_command)

These tests fix the arm shape, the layer->env mapping (the EXACT env keys/values),
CLI resolvability, and — critically — that ``full`` / ``baseline`` stay
byte-identical (they carry none of the new layers or env). No real agent runs:
wiring/env only, like ``test_llm_rerank_arm.py``.
"""
from __future__ import annotations

import pytest

from agentrail.evals.arms import (
    CUTOFF_LAYER,
    GATHER_LAYER,
    LLM_RERANK_LAYER,
    PINNED_GATHER_MODEL,
    PINNED_MODEL,
    PINNED_TEMPERATURE,
    SYMBOL_PACKING_LAYER,
    all_arms,
    baseline,
    cutoff_arm,
    cutoff_arms,
    full,
    gather_arm,
    gather_arms,
    symbol_packing_arm,
    symbol_packing_arms,
)
from agentrail.evals.runner import GATHER_MODEL_ENV, _arm_env
from agentrail.evals.spine import resolve_arm

# The single env var each layer's live resolver reads.
_CUTOFF_ENV = "AGENTRAIL_CONTEXT_PACK_CUTOFF"
_SYMBOL_ENV = "AGENTRAIL_CONTEXT_SYMBOL_PACKING"
_GATHER_ENABLE_ENV = "AGENTRAIL_JIT_GATHER"

# (layer const, arm builder, pair builder) for the two single-flag PLUS layers.
# ``gather`` is tested separately because it sets TWO env vars (flag + model).
_SINGLE_FLAG_LAYERS = [
    (CUTOFF_LAYER, cutoff_arm, cutoff_arms, _CUTOFF_ENV),
    (SYMBOL_PACKING_LAYER, symbol_packing_arm, symbol_packing_arms, _SYMBOL_ENV),
]


# ---------------------------------------------------------------------------
# Layer constants are registered and distinct
# ---------------------------------------------------------------------------


def test_layer_constants_are_registered_and_distinct() -> None:
    names = {CUTOFF_LAYER, SYMBOL_PACKING_LAYER, GATHER_LAYER}
    assert names == {"cutoff", "symbol_packing", "gather"}
    # Distinct from each other and from the existing llm_rerank layer.
    assert len(names | {LLM_RERANK_LAYER}) == 4


# ---------------------------------------------------------------------------
# Arm registration + opt-in shape (parametrised over the single-flag layers)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("layer,arm_fn,_pair,_env", _SINGLE_FLAG_LAYERS)
def test_full_plus_arm_is_full_plus_the_opt_in_layer(layer, arm_fn, _pair, _env) -> None:
    arm = arm_fn()
    assert arm.name == f"full-plus-{layer}"
    # Every base AgentRail layer stays ON (a strict superset of ``full``).
    assert arm.layers == full().layers
    # The opt-in layer rides extra_layers, switched ON.
    assert dict(arm.extra_layers) == {layer: True}


@pytest.mark.parametrize("layer,_arm,pair_fn,_env", _SINGLE_FLAG_LAYERS)
def test_arms_pair_is_full_off_then_full_plus_on(layer, _arm, pair_fn, _env) -> None:
    off, on = pair_fn()
    assert off.name == "full"
    assert on.name == f"full-plus-{layer}"
    # OFF arm carries no extra layer (default-OFF), ON arm sets exactly the layer.
    assert dict(off.extra_layers) == {}
    assert on.extra_layers.get(layer) is True


@pytest.mark.parametrize("layer,arm_fn,_pair,_env", _SINGLE_FLAG_LAYERS)
def test_full_plus_arm_holds_model_and_temperature_fixed_to_full(layer, arm_fn, _pair, _env) -> None:
    """The A/B toggles ONLY the layer — model/temperature match ``full``."""
    f, arm = full(), arm_fn()
    assert arm.model == f.model == PINNED_MODEL
    assert arm.temperature == f.temperature == PINNED_TEMPERATURE


def test_gather_arm_is_full_plus_the_opt_in_layer_with_a_pinned_cheap_model() -> None:
    arm = gather_arm()
    assert arm.name == f"full-plus-{GATHER_LAYER}"
    assert arm.layers == full().layers
    assert dict(arm.extra_layers) == {GATHER_LAYER: True}
    # Gather pins a cheap model that DIFFERS from the implementer's model, else
    # resolve_gather_command trips its independence guard and skips the phase.
    assert arm.gather_model == PINNED_GATHER_MODEL
    assert arm.gather_model != PINNED_MODEL


def test_gather_arms_pair_is_full_off_then_full_plus_on() -> None:
    off, on = gather_arms()
    assert off.name == "full"
    assert on.name == f"full-plus-{GATHER_LAYER}"
    assert dict(off.extra_layers) == {}
    assert on.extra_layers.get(GATHER_LAYER) is True
    # Only the ON arm pins a gather model.
    assert off.gather_model == ""
    assert on.gather_model == PINNED_GATHER_MODEL


# ---------------------------------------------------------------------------
# full / baseline do not carry any of the new layers (byte-identical meaning)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("layer", [CUTOFF_LAYER, SYMBOL_PACKING_LAYER, GATHER_LAYER])
def test_full_and_baseline_do_not_carry_the_new_layers(layer) -> None:
    for arm in (full(), baseline()):
        assert layer not in arm.extra_layers
    # ``full``/``baseline`` also never pin a gather model.
    assert full().gather_model == ""
    assert baseline().gather_model == ""


# ---------------------------------------------------------------------------
# Layer -> env mapping (the runner bridge, single source of truth) — EXACT keys
# ---------------------------------------------------------------------------


def test_arm_env_maps_cutoff_layer_to_the_context_flag() -> None:
    assert _arm_env(cutoff_arm())[_CUTOFF_ENV] == "1"
    assert _CUTOFF_ENV not in _arm_env(full())
    assert _CUTOFF_ENV not in _arm_env(baseline())


def test_arm_env_maps_symbol_packing_layer_to_the_context_flag() -> None:
    assert _arm_env(symbol_packing_arm())[_SYMBOL_ENV] == "1"
    assert _SYMBOL_ENV not in _arm_env(full())
    assert _SYMBOL_ENV not in _arm_env(baseline())


def test_arm_env_maps_gather_layer_to_both_the_enable_flag_and_the_model() -> None:
    """Gather needs BOTH triggers — the enable flag AND the cheap model — or the
    phase resolves to "" and never fires."""
    env = _arm_env(gather_arm())
    assert env[_GATHER_ENABLE_ENV] == "1"
    assert env[GATHER_MODEL_ENV] == PINNED_GATHER_MODEL
    assert GATHER_MODEL_ENV == "AGENTRAIL_EVAL_GATHER_MODEL"
    # ``full`` / ``baseline`` set neither.
    for name in ("full", "baseline"):
        base_env = _arm_env(resolve_arm(name))
        assert _GATHER_ENABLE_ENV not in base_env
        assert GATHER_MODEL_ENV not in base_env


# ---------------------------------------------------------------------------
# CLI resolvability: ``--arm full-plus-<layer>`` resolves to the right arm
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spec,layer",
    [
        ("full-plus-cutoff", CUTOFF_LAYER),
        ("full-plus-symbol_packing", SYMBOL_PACKING_LAYER),
        ("full-plus-gather", GATHER_LAYER),
    ],
)
def test_resolve_arm_resolves_each_full_plus_layer(spec, layer) -> None:
    arm = resolve_arm(spec)
    assert arm.name == spec
    assert arm.extra_layers.get(layer) is True


def test_resolve_arm_rejects_an_unknown_full_plus_layer() -> None:
    with pytest.raises(ValueError, match="unknown full-plus arm layer 'bogus'"):
        resolve_arm("full-plus-bogus")


# ---------------------------------------------------------------------------
# Additive: existing arms are unchanged (byte-identical env + still resolvable)
# ---------------------------------------------------------------------------


def test_full_env_is_unchanged_by_the_new_layers() -> None:
    """``full`` carries no new-layer env — the exact keys it had before stay the
    only context/pipeline toggles it emits."""
    env = _arm_env(full())
    for leaked in (_CUTOFF_ENV, _SYMBOL_ENV, _GATHER_ENABLE_ENV, GATHER_MODEL_ENV,
                   "AGENTRAIL_CONTEXT_LLM_RERANK"):
        assert leaked not in env


@pytest.mark.parametrize(
    "spec",
    [
        "full",
        "baseline",
        "full-minus-rerank",
        "full-minus-expansion",
        "full-plus-llm_rerank",
    ],
)
def test_existing_arms_still_resolve_unchanged(spec) -> None:
    """Every arm that resolved before still resolves to the same-named arm."""
    assert resolve_arm(spec).name == spec


def test_existing_rerank_and_expansion_bridges_are_unchanged() -> None:
    """The pre-existing base-layer bridges keep their exact env behaviour."""
    # rerank OFF -> AGENTRAIL_CONTEXT_RERANK=0
    assert _arm_env(resolve_arm("full-minus-rerank"))["AGENTRAIL_CONTEXT_RERANK"] == "0"
    # expansion ON (full has expansion ON) -> AGENTRAIL_CONTEXT_QUERY_EXPANSION=1
    assert _arm_env(full())["AGENTRAIL_CONTEXT_QUERY_EXPANSION"] == "1"


def test_new_plus_arms_are_opt_in_not_in_the_default_ablation_set() -> None:
    """Like ``full-plus-llm_rerank``, the new PLUS arms are opt-in — reachable
    only by an explicit ``--arm``, never folded into ``all_arms`` / ``--ablation``."""
    names = {a.name for a in all_arms()}
    for layer in (CUTOFF_LAYER, SYMBOL_PACKING_LAYER, GATHER_LAYER, LLM_RERANK_LAYER):
        assert f"full-plus-{layer}" not in names
