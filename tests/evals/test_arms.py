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
    Arm,
    Layers,
    baseline,
    full,
    full_minus,
)


# ---------------------------------------------------------------------------
# AC1 — Arm shape: name + all five layer flags + pinned model/temperature
# ---------------------------------------------------------------------------


def test_arm_has_name_layers_model_and_temperature() -> None:
    arm = full()
    assert isinstance(arm.name, str) and arm.name
    assert isinstance(arm.layers, Layers)
    assert isinstance(arm.model, str) and arm.model
    assert isinstance(arm.temperature, float)


def test_layers_names_are_the_five_documented_layers() -> None:
    assert LAYER_NAMES == ("context", "routing", "verify_gate", "retry", "guardrails")


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
