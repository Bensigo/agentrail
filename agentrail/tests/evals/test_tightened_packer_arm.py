"""Tests for the packer-tightening A/B arm (issue #1225 AC2).

Mirrors ``test_layer_arms.py``'s coverage shape for the other PLUS arms
(cutoff / symbol_packing / gather), but for an arm that composes TWO things
instead of toggling one flag:

    tightened_packer = full() + cutoff layer ON (reused #1096 mechanism)
                               + a SMALLER retrieval_max_tokens (new numeric field)

The runner's ``_arm_env`` must bridge BOTH halves — the existing
``AGENTRAIL_CONTEXT_PACK_CUTOFF`` flag AND the new
``AGENTRAIL_RETRIEVAL_MAX_TOKENS`` override — and ``full`` / ``baseline`` must
stay byte-identical (neither carries the tightened budget). No real agent
runs: wiring/env only.
"""
from __future__ import annotations

from agentrail.context.retrieval import RETRIEVAL_MAX_TOKENS
from agentrail.evals.arms import (
    CUTOFF_LAYER,
    PINNED_MODEL,
    PINNED_TEMPERATURE,
    TIGHTENED_PACKER_LAYER,
    TIGHTENED_PACKER_MAX_TOKENS,
    all_arms,
    baseline,
    full,
    tightened_packer_arm,
    tightened_packer_arms,
)
from agentrail.evals.runner import _arm_env
from agentrail.evals.spine import resolve_arm

_CUTOFF_ENV = "AGENTRAIL_CONTEXT_PACK_CUTOFF"
_BUDGET_ENV = "AGENTRAIL_RETRIEVAL_MAX_TOKENS"


def test_tightened_packer_arm_is_full_plus_cutoff_with_a_smaller_budget() -> None:
    arm = tightened_packer_arm()
    assert arm.name == f"full-plus-{TIGHTENED_PACKER_LAYER}"
    # Every base AgentRail layer stays ON (a strict superset of ``full``).
    assert arm.layers == full().layers
    # Reuses the EXISTING #1096 cutoff mechanism, unchanged.
    assert dict(arm.extra_layers) == {CUTOFF_LAYER: True}
    # The NEW half: a smaller token budget than the current packer's default.
    assert arm.retrieval_max_tokens == TIGHTENED_PACKER_MAX_TOKENS
    assert TIGHTENED_PACKER_MAX_TOKENS < RETRIEVAL_MAX_TOKENS


def test_tightened_packer_arm_holds_model_and_temperature_fixed_to_full() -> None:
    arm = tightened_packer_arm()
    assert arm.model == full().model == PINNED_MODEL
    assert arm.temperature == full().temperature == PINNED_TEMPERATURE


def test_tightened_packer_arms_pair_is_full_off_then_tightened_on() -> None:
    off, on = tightened_packer_arms()
    assert off.name == "full"
    assert on.name == f"full-plus-{TIGHTENED_PACKER_LAYER}"
    assert off.retrieval_max_tokens is None
    assert on.retrieval_max_tokens == TIGHTENED_PACKER_MAX_TOKENS
    assert dict(off.extra_layers) == {}
    assert on.extra_layers.get(CUTOFF_LAYER) is True


def test_full_and_baseline_do_not_carry_the_tightened_budget() -> None:
    assert full().retrieval_max_tokens is None
    assert baseline().retrieval_max_tokens is None
    assert TIGHTENED_PACKER_LAYER not in full().extra_layers
    assert TIGHTENED_PACKER_LAYER not in baseline().extra_layers


def test_arm_env_maps_tightened_packer_to_cutoff_flag_and_smaller_budget() -> None:
    env = _arm_env(tightened_packer_arm())
    assert env[_CUTOFF_ENV] == "1"
    assert env[_BUDGET_ENV] == str(TIGHTENED_PACKER_MAX_TOKENS)
    # full / baseline set neither — byte-identical env to before this arm existed.
    for name in ("full", "baseline"):
        base_env = _arm_env(resolve_arm(name))
        assert _CUTOFF_ENV not in base_env
        assert _BUDGET_ENV not in base_env


def test_resolve_arm_resolves_tightened_packer() -> None:
    arm = resolve_arm("full-plus-tightened_packer")
    assert arm.name == "full-plus-tightened_packer"
    assert arm.retrieval_max_tokens == TIGHTENED_PACKER_MAX_TOKENS


def test_tightened_packer_arm_is_opt_in_not_in_the_default_ablation_set() -> None:
    """Like every other PLUS arm, reachable only by an explicit ``--arm``."""
    names = {a.name for a in all_arms()}
    assert f"full-plus-{TIGHTENED_PACKER_LAYER}" not in names
