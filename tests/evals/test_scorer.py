"""Tests for the eval scorer — the truth-critical core (issue #936).

The scorer takes a fixed ``RunRecord`` plus the task's hidden-test result and
returns a verdict defined SOLELY by the hidden tests passing. These tests fix
the inputs and assert the observable verdict across every gate x hidden-test
combination, plus the false-green probe and the purity guarantee.

The four gate x hidden combinations (gate is the run's OWN Objective Gate
decision, hidden is the ground-truth hidden-test result):

    gate=pass, hidden=pass -> solved,      not false-green
    gate=fail, hidden=pass -> solved,      not false-green   (AC1)
    gate=pass, hidden=fail -> NOT solved,  FALSE-GREEN        (AC2)
    gate=fail, hidden=fail -> NOT solved,  not false-green    (AC3)
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from agentrail.run.usage_capture import Usage

from agentrail.evals.run_record import RetryEvent, RunRecord
from agentrail.evals.scorer import Verdict, score


MODEL = "claude-sonnet-4-5"


def _record(*, gate_passed: bool, task: str = "task-a", arm: str = "full") -> RunRecord:
    """A fixed run record whose only verdict-relevant field is ``gate_passed``."""
    return RunRecord(
        task=task,
        arm=arm,
        diff="--- a/x\n+++ b/x\n@@\n+pass\n",
        model=MODEL,
        usage=Usage(model=MODEL, input_tokens=1000, output_tokens=500, cache_tokens=0),
        wall_time_s=10.0,
        gate_passed=gate_passed,
        retries=[RetryEvent(attempt=1, model=MODEL, gate_passed=gate_passed)],
    )


# ---------------------------------------------------------------------------
# AC1 — verdict is defined SOLELY by the hidden tests, regardless of the gate.
# All four gate x hidden combinations asserted explicitly.
# ---------------------------------------------------------------------------


def test_gate_pass_hidden_pass_is_solved_not_false_green() -> None:
    v = score(_record(gate_passed=True), hidden_tests_passed=True)
    assert v.solved is True
    assert v.false_green is False


def test_gate_fail_hidden_pass_is_solved_not_false_green() -> None:
    """AC1: hidden passed -> solved EVEN THOUGH the run's own gate said fail."""
    v = score(_record(gate_passed=False), hidden_tests_passed=True)
    assert v.solved is True
    assert v.false_green is False


def test_gate_pass_hidden_fail_is_failed_and_false_green() -> None:
    """AC2: gate passed but hidden failed -> failed AND recorded false-green."""
    v = score(_record(gate_passed=True), hidden_tests_passed=False)
    assert v.solved is False
    assert v.false_green is True


def test_gate_fail_hidden_fail_is_failed_not_false_green() -> None:
    """AC3: gate failed + hidden failed -> failed but NOT a false-green."""
    v = score(_record(gate_passed=False), hidden_tests_passed=False)
    assert v.solved is False
    assert v.false_green is False


@pytest.mark.parametrize(
    "gate_passed,hidden_passed,expected_solved,expected_false_green",
    [
        (True, True, True, False),
        (False, True, True, False),
        (True, False, False, True),
        (False, False, False, False),
    ],
)
def test_all_gate_hidden_combinations(
    gate_passed: bool,
    hidden_passed: bool,
    expected_solved: bool,
    expected_false_green: bool,
) -> None:
    """The full truth table in one place: solved == hidden, never the gate."""
    v = score(_record(gate_passed=gate_passed), hidden_tests_passed=hidden_passed)
    assert v.solved is expected_solved
    assert v.solved is hidden_passed  # solved IS the hidden-test result, nothing else
    assert v.false_green is expected_false_green


# ---------------------------------------------------------------------------
# Verdict shape / labels carried through for aggregation.
# ---------------------------------------------------------------------------


def test_verdict_carries_task_arm_and_gate_decision() -> None:
    v = score(_record(gate_passed=True, task="t7", arm="full-minus-context"), hidden_tests_passed=False)
    assert isinstance(v, Verdict)
    assert v.task == "t7"
    assert v.arm == "full-minus-context"
    assert v.gate_passed is True


def test_solved_run_can_never_be_false_green() -> None:
    """Invariant: a false-green is by construction always an unsolved run."""
    for gate in (True, False):
        v = score(_record(gate_passed=gate), hidden_tests_passed=True)
        assert not (v.solved and v.false_green)


def test_verdict_solved_feeds_reporter_repetition_record() -> None:
    """The scorer's ``solved`` is exactly what the reporter consumes."""
    from agentrail.evals.reporter import RepetitionRecord

    run = _record(gate_passed=True)
    v = score(run, hidden_tests_passed=True)
    rep = RepetitionRecord(task=run.task, arm=run.arm, solved=v.solved, usage=run.usage)
    assert rep.solved is True


def test_score_is_pure_function_referentially_transparent() -> None:
    """Same inputs -> same verdict, repeatedly (no hidden state)."""
    run = _record(gate_passed=True)
    a = score(run, hidden_tests_passed=False)
    b = score(run, hidden_tests_passed=False)
    assert a == b


# ---------------------------------------------------------------------------
# AC4 — purity: no subprocess / sandbox / network IO.
# ---------------------------------------------------------------------------


def test_scorer_module_imports_no_execution_or_network_modules() -> None:
    """Static guard (mirrors #933): the scorer imports no IO primitives."""
    module_path = (
        Path(__file__).resolve().parents[2] / "agentrail" / "evals" / "scorer.py"
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
        "pathlib",
    }
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    leaked = imported & forbidden
    assert not leaked, f"scorer must not import execution/IO modules: {sorted(leaked)}"


def test_score_runs_no_subprocess(monkeypatch) -> None:
    """Behavioural guard: scoring must spawn no process, even if asked to.

    We make every subprocess entry point explode; ``score`` must still return.
    """
    import subprocess

    def _boom(*args: object, **kwargs: object):  # pragma: no cover - must not run
        raise AssertionError("scorer must not spawn a subprocess")

    monkeypatch.setattr(subprocess, "Popen", _boom)
    monkeypatch.setattr(subprocess, "run", _boom)
    monkeypatch.setattr(subprocess, "call", _boom)

    v = score(_record(gate_passed=True), hidden_tests_passed=False)
    assert v.false_green is True


def test_score_opens_no_socket(monkeypatch) -> None:
    """Behavioural guard: scoring must open no network socket."""
    import socket

    def _boom(*args: object, **kwargs: object):  # pragma: no cover - must not run
        raise AssertionError("scorer must not open a socket")

    monkeypatch.setattr(socket, "socket", _boom)

    v = score(_record(gate_passed=False), hidden_tests_passed=True)
    assert v.solved is True


def test_score_does_not_mutate_the_run_record() -> None:
    """The scorer treats its input as immutable evidence."""
    run = _record(gate_passed=True)
    before = (run.task, run.arm, run.gate_passed, run.diff, run.model, run.wall_time_s)
    score(run, hidden_tests_passed=False)
    after = (run.task, run.arm, run.gate_passed, run.diff, run.model, run.wall_time_s)
    assert before == after
