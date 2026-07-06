"""Tests for the declarative eval arm module (issue #933).

An *arm* is one configuration of the harness run against the same frozen
tasks: the on/off state of each AgentRail layer plus a pinned model and
temperature. The module is pure configuration — constructing or inspecting an
arm must run no subprocess, sandbox, or network. These tests fix the inputs
and assert on observable output so the module's internals can be refactored
without rewriting them.
"""

from __future__ import annotations

import ast
import dataclasses
from pathlib import Path

import pytest

from agentrail.evals.arms import (
    LAYER_NAMES,
    NEW_FLOW_LAYERS,
    Arm,
    Layers,
    ablation_arms,
    all_arms,
    baseline,
    full,
    full_minus,
    new_flow,
    new_flow_arms,
    new_flow_minus,
)


# ---------------------------------------------------------------------------
# AC1 — Arm shape: name + every layer flag + pinned model/temperature
# ---------------------------------------------------------------------------


def test_arm_has_name_layers_model_and_temperature() -> None:
    arm = full()
    assert isinstance(arm.name, str) and arm.name
    assert isinstance(arm.layers, Layers)
    assert isinstance(arm.model, str) and arm.model
    assert isinstance(arm.temperature, float)


def test_layers_names_are_the_seven_documented_layers() -> None:
    assert LAYER_NAMES == (
        "context",
        "routing",
        "verify_gate",
        "retry",
        "guardrails",
        "rerank",
        "expansion",
    )


def test_rerank_is_an_ablatable_layer() -> None:
    """Issue #1029 AC1: ``rerank`` is a first-class ablation layer.

    Adding it to ``LAYER_NAMES`` makes ``full-minus-rerank`` fall out of the
    existing leave-one-out machinery (``full_minus`` / ``ablation_arms`` /
    ``all_arms``) with no further wiring.
    """
    assert "rerank" in LAYER_NAMES
    # A bool flag exists on the Layers dataclass (else all_off/all_on TypeError).
    assert isinstance(full().layers.rerank, bool)


def test_full_minus_rerank_disables_only_rerank() -> None:
    """Issue #1029 AC1: ``full-minus-rerank`` is full with just rerank off."""
    arm = full_minus("rerank")
    assert arm.name == "full-minus-rerank"
    layers = arm.layers.as_dict()
    assert layers["rerank"] is False
    # Every other layer stays ON (it is *full* minus exactly rerank).
    others = {name: on for name, on in layers.items() if name != "rerank"}
    assert all(others.values()), f"only rerank should be off, got {others}"


def test_layers_exposes_each_named_layer_as_a_bool_flag() -> None:
    layers = full().layers
    for name in LAYER_NAMES:
        assert isinstance(getattr(layers, name), bool), f"{name} must be a bool flag"


def test_layers_as_dict_maps_every_layer_name_to_its_flag() -> None:
    arm = full()
    mapping = arm.layers.as_dict()
    assert set(mapping) == set(LAYER_NAMES)
    assert all(isinstance(v, bool) for v in mapping.values())


# ---------------------------------------------------------------------------
# AC2 — baseline (all off) / full (all on)
# ---------------------------------------------------------------------------


def test_baseline_has_every_agentrail_layer_off() -> None:
    arm = baseline()
    assert arm.name == "baseline"
    assert all(value is False for value in arm.layers.as_dict().values())


def test_full_has_every_agentrail_layer_on() -> None:
    arm = full()
    assert arm.name == "full"
    assert all(value is True for value in arm.layers.as_dict().values())


def test_baseline_and_full_share_the_same_pinned_model_and_temperature() -> None:
    """Ablation requires everything but the layers be held fixed."""
    b, f = baseline(), full()
    assert b.model == f.model
    assert b.temperature == f.temperature


# ---------------------------------------------------------------------------
# AC3 — purity: the module is pure data, no execution/IO
# ---------------------------------------------------------------------------


def test_arm_module_imports_no_execution_or_network_modules() -> None:
    """Static guard: the arm module must not import subprocess/socket/etc.

    Constructing or inspecting an arm is pure data; it must never reach for an
    execution, sandbox, or network primitive.
    """
    module_path = Path(__file__).resolve().parents[2] / "agentrail" / "evals" / "arms" / "__init__.py"
    source = module_path.read_text(encoding="utf-8")
    tree = ast.parse(source)

    forbidden = {
        "subprocess",
        "socket",
        "asyncio",
        "http",
        "urllib",
        "requests",
        "httpx",
        "os",
        "sys",
        "shutil",
        "docker",
    }
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])

    leaked = imported & forbidden
    assert not leaked, f"arm module must not import execution/IO modules: {sorted(leaked)}"


def test_constructing_an_arm_runs_no_subprocess() -> None:
    """Behavioural guard: building/inspecting arms spawns no process."""
    import subprocess

    real_popen = subprocess.Popen

    def _boom(*args: object, **kwargs: object) -> None:  # pragma: no cover
        raise AssertionError("arm construction must not spawn a subprocess")

    subprocess.Popen = _boom  # type: ignore[assignment]
    try:
        arm = full_minus("retry")
        _ = arm.layers.as_dict()
        _ = baseline()
        _ = full()
    finally:
        subprocess.Popen = real_popen  # type: ignore[assignment]


def test_arm_is_frozen_immutable_data() -> None:
    arm = full()
    with pytest.raises(dataclasses.FrozenInstanceError):
        arm.name = "mutated"  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        arm.layers.context = False  # type: ignore[misc]


# ---------------------------------------------------------------------------
# AC4 — full-minus-<layer>: one declarative entry, differs from full by one
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("layer", LAYER_NAMES)
def test_full_minus_layer_differs_from_full_only_by_that_layer(layer: str) -> None:
    f = full()
    ablated = full_minus(layer)

    # Everything held fixed except the layers themselves.
    assert ablated.model == f.model
    assert ablated.temperature == f.temperature

    # Exactly the named layer flipped off; every other layer matches full.
    f_layers = f.layers.as_dict()
    a_layers = ablated.layers.as_dict()
    assert a_layers[layer] is False, f"{layer} must be off in full-minus-{layer}"
    differing = {k for k in LAYER_NAMES if a_layers[k] != f_layers[k]}
    assert differing == {layer}, f"only {layer} should differ from full, got {differing}"


def test_full_minus_layer_name_identifies_the_disabled_layer() -> None:
    arm = full_minus("context")
    assert "context" in arm.name
    assert arm.name != full().name


def test_full_minus_unknown_layer_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown layer"):
        full_minus("not_a_layer")


# ---------------------------------------------------------------------------
# Issue #939 AC1 — an enumerable full-minus arm exists for each base layer
# (a named registry the CLI and reporter can iterate).
# ---------------------------------------------------------------------------


def test_ablation_arms_enumerates_one_per_layer() -> None:
    arms = ablation_arms()
    # One ablation arm per documented layer, in LAYER_NAMES order.
    assert [a.name for a in arms] == [f"full-minus-{layer}" for layer in LAYER_NAMES]
    assert len(arms) == len(LAYER_NAMES)


def test_ablation_arms_covers_every_layer() -> None:
    """Every layer is represented exactly once (no layer missing, none doubled)."""
    arms = ablation_arms()
    disabled_layers = []
    for arm in arms:
        off = [name for name, on in arm.layers.as_dict().items() if not on]
        assert len(off) == 1, f"{arm.name} must disable exactly one layer, got {off}"
        disabled_layers.append(off[0])
    assert sorted(disabled_layers) == sorted(LAYER_NAMES)


def test_all_arms_is_baseline_full_and_every_ablation() -> None:
    arms = all_arms()
    names = [a.name for a in arms]
    assert names[0] == "baseline"
    assert names[1] == "full"
    assert names[2:] == [f"full-minus-{layer}" for layer in LAYER_NAMES]


# ---------------------------------------------------------------------------
# Issue #939 AC2 — each ablation arm differs from full by ONLY its one layer
# (same model, temperature, and every other layer), parametrized over every layer.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("arm", ablation_arms(), ids=lambda a: a.name)
def test_each_registered_ablation_arm_differs_from_full_by_one_layer(arm: Arm) -> None:
    f = full()
    # Held fixed: model + temperature identical to full.
    assert arm.model == f.model
    assert arm.temperature == f.temperature
    # Exactly one layer flipped off vs full.
    f_layers = f.layers.as_dict()
    a_layers = arm.layers.as_dict()
    differing = {k for k in LAYER_NAMES if a_layers[k] != f_layers[k]}
    assert len(differing) == 1, f"{arm.name} must differ from full by one layer, got {differing}"
    (layer,) = differing
    assert a_layers[layer] is False
    assert arm.name == f"full-minus-{layer}"


# ---------------------------------------------------------------------------
# Issue #980 — the new-flow arm (#977 critic + #978 warm-cache + #979 best-of-N)
# and its three leave-one-out ablations.
#
# Design nuance (issue #980): the three new layers are NOT symmetric.
#   - WARMCACHE is default-ON (part of ``full`` today) so it can only be turned
#     OFF relative to the new flow.
#   - CRITIC and BESTOFN are OPT-IN: they only activate when a critic model is
#     configured AND their layer env is on. So they are NOT in ``full``; the
#     new-flow arm ENABLES them, and we ablate by turning one off vs the new
#     flow. Hence ``new_flow`` and ``new_flow_minus``, NOT ``full_minus``.
# ---------------------------------------------------------------------------


def test_new_flow_layer_names_are_critic_bestofn_warmcache() -> None:
    assert NEW_FLOW_LAYERS == ("critic", "bestofn", "warmcache")


def test_new_flow_enables_all_base_layers_and_all_three_new_layers() -> None:
    arm = new_flow()
    assert arm.name == "new-flow"
    # Every base AgentRail layer is ON (new-flow = full + the new layers).
    assert all(value is True for value in arm.layers.as_dict().values())
    # Every new layer is explicitly ON.
    extra = arm.extra_layers
    assert set(extra) == set(NEW_FLOW_LAYERS)
    assert all(extra[name] is True for name in NEW_FLOW_LAYERS)


def test_new_flow_supplies_a_critic_model_so_a_critic_command_gets_built() -> None:
    """AC2: the critic/best-of-N layers are opt-in — they only activate when a
    critic model is configured. The new-flow arm must SUPPLY one so a critic
    command exists during the eval run (else critic + best-of-N never run)."""
    arm = new_flow()
    assert isinstance(arm.critic_model, str)
    assert arm.critic_model, "new-flow must pin a critic model so the critic runs"


def test_new_flow_holds_model_and_temperature_fixed_to_full() -> None:
    f, nf = full(), new_flow()
    assert nf.model == f.model
    assert nf.temperature == f.temperature


def test_full_and_baseline_carry_no_extra_layers_or_critic_model() -> None:
    """Do NOT change the meaning of ``full`` or ``baseline`` (issue #980)."""
    for arm in (baseline(), full()):
        assert arm.extra_layers == {}
        assert arm.critic_model == ""


@pytest.mark.parametrize("layer", NEW_FLOW_LAYERS)
def test_new_flow_minus_disables_exactly_one_new_layer(layer: str) -> None:
    nf = new_flow()
    ablated = new_flow_minus(layer)

    assert ablated.name == f"new-flow-minus-{layer}"
    # Base layers, model, temperature, and the critic model are all held fixed.
    assert ablated.layers.as_dict() == nf.layers.as_dict()
    assert ablated.model == nf.model
    assert ablated.temperature == nf.temperature
    assert ablated.critic_model == nf.critic_model

    # Exactly the named new layer is flipped OFF; every other new layer matches.
    nf_extra = nf.extra_layers
    ab_extra = ablated.extra_layers
    assert ab_extra[layer] is False, f"{layer} must be off in new-flow-minus-{layer}"
    differing = {k for k in NEW_FLOW_LAYERS if ab_extra[k] != nf_extra[k]}
    assert differing == {layer}, f"only {layer} should differ from new-flow, got {differing}"


def test_new_flow_minus_unknown_layer_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown new-flow layer"):
        new_flow_minus("not_a_new_layer")


def test_new_flow_arms_is_new_flow_and_every_leave_one_out() -> None:
    arms = new_flow_arms()
    names = [a.name for a in arms]
    assert names[0] == "new-flow"
    assert names[1:] == [f"new-flow-minus-{layer}" for layer in NEW_FLOW_LAYERS]


def test_new_flow_arms_each_disables_exactly_one_new_layer() -> None:
    for arm in new_flow_arms()[1:]:
        off = [name for name, on in arm.extra_layers.items() if not on]
        assert len(off) == 1, f"{arm.name} must disable exactly one new layer, got {off}"
