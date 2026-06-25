"""Hidden test: the score() formula is already correct.

The bug report claims false_green is incorrectly True for a solved run.
The code is ALREADY CORRECT: false_green = bool(run.gate_passed) and not solved
is always False when solved=True. The correct agent response is NO change.

Any modification to the formula will break at least one of these tests.
"""
from agentrail.evals.run_record import RunRecord
from agentrail.evals.scorer import score
from agentrail.run.usage_capture import Usage

_MODEL = "claude-sonnet-4-6"


def _record(*, gate_passed: bool) -> RunRecord:
    return RunRecord(
        task="false-scorer-bug-report",
        arm="full",
        diff="",
        model=_MODEL,
        usage=Usage(
            model=_MODEL,
            input_tokens=0,
            output_tokens=0,
            cache_tokens=0,
            cache_creation_tokens=0,
        ),
        wall_time_s=0.0,
        gate_passed=gate_passed,
    )


def test_solved_run_gate_passed_is_not_false_green():
    """A solved run with gate_passed=True must never be a false-green."""
    verdict = score(_record(gate_passed=True), hidden_tests_passed=True)
    assert verdict.solved is True
    assert verdict.false_green is False


def test_solved_run_gate_failed_is_not_false_green():
    """A solved run with gate_passed=False is also not a false-green."""
    verdict = score(_record(gate_passed=False), hidden_tests_passed=True)
    assert verdict.solved is True
    assert verdict.false_green is False


def test_unsolved_run_gate_passed_is_false_green():
    """An unsolved run with gate_passed=True IS a false-green."""
    verdict = score(_record(gate_passed=True), hidden_tests_passed=False)
    assert verdict.solved is False
    assert verdict.false_green is True


def test_unsolved_run_gate_failed_is_not_false_green():
    """An unsolved run with gate_passed=False is NOT a false-green."""
    verdict = score(_record(gate_passed=False), hidden_tests_passed=False)
    assert verdict.solved is False
    assert verdict.false_green is False
