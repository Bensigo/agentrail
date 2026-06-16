"""Tests for agentrail/run/objective_gate.py — the deep, pure Objective Gate.

The Objective Gate is the falsifiable definition of "done" (ADR 0007): it goes
GREEN only when tests, build, and lint pass AND the issue's acceptance-criteria
coverage is satisfied; otherwise it goes RED with evidence naming what failed.

These are behavior-only unit tests over plain fixtures — the gate is pure, so it
takes already-computed check *results* and AC coverage as inputs and returns a
verdict. It never runs real tools (that is thin pipeline orchestration).
"""
from __future__ import annotations

from agentrail.run.objective_gate import (
    AcCoverage,
    CheckResult,
    evaluate,
)


def _passing_checks() -> list[CheckResult]:
    return [
        CheckResult(name="tests", passed=True, detail="42 passed"),
        CheckResult(name="build", passed=True, detail="build ok"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]


def _full_coverage() -> AcCoverage:
    return AcCoverage(total=3, covered=3)


# ---------------------------------------------------------------------------
# AC1 — green only when tests + build + lint pass AND AC coverage satisfied
# ---------------------------------------------------------------------------

def test_green_when_all_checks_pass_and_ac_covered() -> None:
    result = evaluate(checks=_passing_checks(), ac_coverage=_full_coverage())
    assert result.is_green is True


def test_green_result_carries_evidence_for_every_check() -> None:
    result = evaluate(checks=_passing_checks(), ac_coverage=_full_coverage())
    names = {e.name for e in result.evidence}
    assert {"tests", "build", "lint"} <= names


def test_red_when_tests_fail() -> None:
    checks = [
        CheckResult(name="tests", passed=False, detail="2 failed"),
        CheckResult(name="build", passed=True, detail="build ok"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]
    result = evaluate(checks=checks, ac_coverage=_full_coverage())
    assert result.is_green is False


def test_red_evidence_names_the_failing_check() -> None:
    checks = [
        CheckResult(name="tests", passed=False, detail="2 failed"),
        CheckResult(name="build", passed=True, detail="build ok"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]
    result = evaluate(checks=checks, ac_coverage=_full_coverage())
    assert "tests" in result.failed_reasons


def test_red_when_build_fails() -> None:
    checks = [
        CheckResult(name="tests", passed=True, detail="42 passed"),
        CheckResult(name="build", passed=False, detail="compile error"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]
    result = evaluate(checks=checks, ac_coverage=_full_coverage())
    assert result.is_green is False
    assert "build" in result.failed_reasons


def test_red_when_lint_fails() -> None:
    checks = [
        CheckResult(name="tests", passed=True, detail="42 passed"),
        CheckResult(name="build", passed=True, detail="build ok"),
        CheckResult(name="lint", passed=False, detail="3 lint errors"),
    ]
    result = evaluate(checks=checks, ac_coverage=_full_coverage())
    assert result.is_green is False
    assert "lint" in result.failed_reasons


def test_red_when_ac_coverage_missing() -> None:
    """All tools green, but not every acceptance criterion is covered → RED."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=AcCoverage(total=3, covered=2),
    )
    assert result.is_green is False
    assert any("acceptance" in r.lower() for r in result.failed_reasons)


def test_red_when_no_acceptance_criteria_declared() -> None:
    """An issue with zero declared acceptance criteria cannot reach green —
    there is nothing objective to satisfy (ADR 0007's input-contract spirit)."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=AcCoverage(total=0, covered=0),
    )
    assert result.is_green is False


def test_multiple_failures_all_reported() -> None:
    checks = [
        CheckResult(name="tests", passed=False, detail="2 failed"),
        CheckResult(name="build", passed=False, detail="compile error"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]
    result = evaluate(checks=checks, ac_coverage=AcCoverage(total=3, covered=1))
    assert result.is_green is False
    assert "tests" in result.failed_reasons
    assert "build" in result.failed_reasons


# ---------------------------------------------------------------------------
# Red-Green Proof seam (issue #772) — present but not built here.
# When evidence is required and absent, the gate stays red even on all-pass;
# the default (None / not required) keeps this PR's behavior unchanged.
# ---------------------------------------------------------------------------

def test_green_when_red_green_proof_not_required() -> None:
    """Default seam: no Red-Green Proof supplied and none required → all-pass is green."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        red_green_evidence=None,
    )
    assert result.is_green is True


def test_red_when_red_green_proof_required_but_invalid() -> None:
    """Seam for #772: if a Red-Green Proof is required but the trail is not
    valid, the gate is red even though tools pass and AC is covered."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        red_green_evidence={"required": True, "valid": False},
    )
    assert result.is_green is False
    assert any("red-green" in r.lower() for r in result.failed_reasons)


def test_green_when_red_green_proof_required_and_valid() -> None:
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        red_green_evidence={"required": True, "valid": True},
    )
    assert result.is_green is True


# ---------------------------------------------------------------------------
# Serialization — the verdict must be persistable for the run surface (AC3).
# ---------------------------------------------------------------------------

def test_result_serializes_to_plain_dict() -> None:
    result = evaluate(checks=_passing_checks(), ac_coverage=_full_coverage())
    payload = result.to_dict()
    assert payload["verdict"] == "green"
    assert isinstance(payload["evidence"], list)


def test_red_result_serializes_with_failed_reasons() -> None:
    checks = [
        CheckResult(name="tests", passed=False, detail="2 failed"),
        CheckResult(name="build", passed=True, detail="build ok"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]
    result = evaluate(checks=checks, ac_coverage=_full_coverage())
    payload = result.to_dict()
    assert payload["verdict"] == "red"
    assert "tests" in payload["failedReasons"]


# ---------------------------------------------------------------------------
# Independent Verification seam (#782, ADR 0008): a Verifier REJECTION blocks
# done. The gate accepts an optional ``verification_evidence`` mapping mirroring
# the Red-Green seam; required + invalid → RED even on an all-pass run (AC3).
# ---------------------------------------------------------------------------

def test_red_when_verification_required_and_invalid() -> None:
    """A blocking Verifier rejection turns an otherwise-green gate RED (AC3)."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        verification_evidence={"required": True, "valid": False,
                               "reason": "tautological test"},
    )
    assert result.is_green is False
    assert any("verification" in r.lower() for r in result.failed_reasons)


def test_green_when_verification_required_and_valid() -> None:
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        verification_evidence={"required": True, "valid": True},
    )
    assert result.is_green is True


def test_verification_not_required_keeps_prior_behavior() -> None:
    """``None`` verification evidence (the default) leaves the gate unchanged."""
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        verification_evidence=None,
    )
    assert result.is_green is True


def test_verification_evidence_appears_in_trail() -> None:
    result = evaluate(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        verification_evidence={"required": True, "valid": False, "reason": "gamed"},
    )
    names = {e.name for e in result.evidence}
    assert "independent-verification" in names
