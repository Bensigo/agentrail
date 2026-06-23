"""Tests for the shared RunRecord contract (issue #936).

``RunRecord`` is the seam the runner (#937) produces and the scorer consumes.
These tests fix its shape and prove it is pure, immutable data carrying the
fields downstream stages depend on (diff, usage, model, wall time, the
Objective-Gate decision, and retry events) — and crucially that it carries the
gate decision as an *observation*, never a ``solved`` verdict.
"""

from __future__ import annotations

import ast
import dataclasses
from pathlib import Path

import pytest

from agentrail.run.usage_capture import Usage

from agentrail.evals.run_record import RetryEvent, RunRecord


MODEL = "claude-sonnet-4-5"


def _usage() -> Usage:
    return Usage(
        model=MODEL,
        input_tokens=1000,
        output_tokens=500,
        cache_tokens=200,
        cache_creation_tokens=100,
    )


def _record(**overrides) -> RunRecord:
    base = dict(
        task="task-a",
        arm="full",
        diff="--- a/x\n+++ b/x\n@@\n+pass\n",
        model=MODEL,
        usage=_usage(),
        wall_time_s=12.5,
        gate_passed=True,
    )
    base.update(overrides)
    return RunRecord(**base)


# ---------------------------------------------------------------------------
# Shape: the contract carries everything #937/#938 must satisfy.
# ---------------------------------------------------------------------------


def test_run_record_carries_the_contract_fields() -> None:
    rec = _record()
    assert rec.task == "task-a"
    assert rec.arm == "full"
    assert isinstance(rec.diff, str)
    assert rec.model == MODEL
    assert isinstance(rec.usage, Usage)
    assert rec.wall_time_s == pytest.approx(12.5)
    assert isinstance(rec.gate_passed, bool)
    assert rec.retries == []


def test_usage_is_the_production_usage_shape_priceable_by_cost_usd() -> None:
    """The usage field is the same shape the single-source pricer reads."""
    from agentrail.run.pricing import cost_usd

    rec = _record()
    # Must not raise / must produce a real (non-zero) price for a known model.
    assert cost_usd(rec.usage) > 0.0


def test_run_record_has_no_solved_field() -> None:
    """The record carries the gate *observation*, never a solved verdict.

    Conflating the run's own gate with ground truth is exactly the false-green
    trap; the verdict belongs to the scorer, not the run record.
    """
    field_names = {f.name for f in dataclasses.fields(RunRecord)}
    assert "solved" not in field_names
    assert "gate_passed" in field_names


# ---------------------------------------------------------------------------
# Retry events + derived helpers.
# ---------------------------------------------------------------------------


def test_attempts_counts_implicit_first_attempt_plus_retries() -> None:
    assert _record().attempts == 1
    rec = _record(
        retries=[
            RetryEvent(attempt=1, model=MODEL, gate_passed=False, reason="gate red"),
            RetryEvent(attempt=2, model="claude-opus-4-6", gate_passed=True, reason="escalation"),
        ]
    )
    assert rec.attempts == 3


def test_final_model_reflects_last_retry_then_falls_back() -> None:
    assert _record().final_model == MODEL
    rec = _record(
        retries=[RetryEvent(attempt=1, model="claude-opus-4-6", gate_passed=True)]
    )
    assert rec.final_model == "claude-opus-4-6"


# ---------------------------------------------------------------------------
# Immutability: a record handed to the scorer cannot be mutated.
# ---------------------------------------------------------------------------


def test_run_record_is_frozen() -> None:
    rec = _record()
    with pytest.raises(dataclasses.FrozenInstanceError):
        rec.gate_passed = False  # type: ignore[misc]


def test_retry_event_is_frozen() -> None:
    ev = RetryEvent(attempt=1, model=MODEL, gate_passed=False)
    with pytest.raises(dataclasses.FrozenInstanceError):
        ev.gate_passed = True  # type: ignore[misc]


def test_default_retries_list_is_not_shared_between_instances() -> None:
    """A mutable default must not leak across records (dataclass field guard)."""
    a = _record()
    b = _record()
    assert a.retries is not b.retries


# ---------------------------------------------------------------------------
# Purity: the contract module imports no execution/IO primitives.
# ---------------------------------------------------------------------------


def test_run_record_module_imports_no_execution_or_network_modules() -> None:
    module_path = (
        Path(__file__).resolve().parents[2]
        / "agentrail"
        / "evals"
        / "run_record.py"
    )
    tree = ast.parse(module_path.read_text(encoding="utf-8"))
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
    assert not leaked, f"run_record must not import execution/IO modules: {sorted(leaked)}"
