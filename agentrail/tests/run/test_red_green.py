"""Tests for agentrail/run/red_green.py — the deep, pure Red-Green Proof recorder.

The **Red-Green Proof** (CONTEXT.md, ADR 0008) is the required evidence that an
acceptance test was observed *failing* before implementation and *passing* after.
It proves the test is real (not tautological) and that the change caused the pass.

These are behavior-only unit tests over plain fixtures — the recorder is pure: it
takes an observed sequence of test results and decides whether they constitute a
valid fail→pass trail. It runs no tools and touches no I/O.
"""
from __future__ import annotations

from agentrail.run.objective_gate import AcCoverage, CheckResult, evaluate
from agentrail.run.red_green import (
    Observation,
    gate_evidence,
    verify_trail,
)


def _passing_checks() -> list[CheckResult]:
    return [CheckResult(name="tests", passed=True, detail="ok")]


# ---------------------------------------------------------------------------
# AC1 — a fail-then-pass sequence is accepted as a valid Red-Green trail.
# ---------------------------------------------------------------------------

def test_fail_then_pass_is_a_valid_trail() -> None:
    trail = verify_trail(
        [
            Observation(test="test_login_rejects_bad_password", passed=False),
            Observation(test="test_login_rejects_bad_password", passed=True),
        ]
    )
    assert trail.is_valid is True


# ---------------------------------------------------------------------------
# AC2 — a never-failed (tautological) test is rejected.
# ---------------------------------------------------------------------------

def test_never_failed_test_is_rejected_as_tautological() -> None:
    """A test only ever observed passing was never red, so it proves nothing —
    it could be tautological. Reject it (CONTEXT.md: not just a final green)."""
    trail = verify_trail(
        [
            Observation(test="test_always_true", passed=True),
            Observation(test="test_always_true", passed=True),
        ]
    )
    assert trail.is_valid is False


def test_empty_trail_is_rejected() -> None:
    """No observation at all is not a proof of anything → rejected."""
    assert verify_trail([]).is_valid is False


def test_pass_then_fail_is_rejected() -> None:
    """A test that passed first and only later failed never went red→green, so
    it is not a valid trail (the final state is not even green)."""
    trail = verify_trail(
        [
            Observation(test="test_x", passed=True),
            Observation(test="test_x", passed=False),
        ]
    )
    assert trail.is_valid is False


def test_valid_trail_when_one_of_many_tests_went_red_then_green() -> None:
    """The trail is valid if at least one acceptance test was observed
    failing then passing, even alongside other always-passing observations."""
    trail = verify_trail(
        [
            Observation(test="test_unrelated", passed=True),
            Observation(test="test_target", passed=False),
            Observation(test="test_target", passed=True),
        ]
    )
    assert trail.is_valid is True


# ---------------------------------------------------------------------------
# Gate bridge — the recorder emits the red_green_evidence the Objective Gate
# consumes ({"required": ..., "valid": ...}). This is the AC3 seam.
# ---------------------------------------------------------------------------

def test_gate_evidence_requires_and_marks_valid_for_a_good_trail() -> None:
    trail = verify_trail(
        [
            Observation(test="test_x", passed=False),
            Observation(test="test_x", passed=True),
        ]
    )
    evidence = gate_evidence(trail)
    assert evidence["required"] is True
    assert evidence["valid"] is True


def test_gate_evidence_marks_invalid_for_a_never_red_trail() -> None:
    trail = verify_trail([Observation(test="test_x", passed=True)])
    evidence = gate_evidence(trail)
    assert evidence["required"] is True
    assert evidence["valid"] is False


def test_gate_evidence_for_no_observations_is_required_and_invalid() -> None:
    """A run that recorded no observations has no proof → gate must refuse."""
    evidence = gate_evidence(verify_trail([]))
    assert evidence["required"] is True
    assert evidence["valid"] is False


# ---------------------------------------------------------------------------
# AC3 — the Objective Gate refuses done without a valid Red-Green trail, even
# when all the objective checks pass. Exercises the real recorder→gate path.
# ---------------------------------------------------------------------------

def test_gate_refuses_done_when_trail_is_tautological() -> None:
    """All checks pass + AC covered, but the acceptance test was never observed
    failing (tautological). The gate must NOT be green (ADR 0008 / AC3)."""
    trail = verify_trail(
        [
            Observation(test="tests", passed=True),  # never red
            Observation(test="tests", passed=True),
        ]
    )
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=AcCoverage(total=1, covered=1),
        red_green_evidence=gate_evidence(trail),
    )
    assert result.is_green is False
    assert any("red-green" in r.lower() for r in result.failed_reasons)


def test_gate_allows_done_with_a_valid_fail_then_pass_trail() -> None:
    trail = verify_trail(
        [
            Observation(test="tests", passed=False),  # red before
            Observation(test="tests", passed=True),   # green after
        ]
    )
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=AcCoverage(total=1, covered=1),
        red_green_evidence=gate_evidence(trail),
    )
    assert result.is_green is True


def test_gate_refuses_done_when_no_trail_recorded() -> None:
    """A run that recorded no observations has no proof → gate refuses done."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=AcCoverage(total=1, covered=1),
        red_green_evidence=gate_evidence(verify_trail([])),
    )
    assert result.is_green is False
