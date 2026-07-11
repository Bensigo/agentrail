"""Issue #920: the unified Objective Gate — one definition of done for BOTH harnesses.

AC1/AC4/AC5 are covered structurally here; the heart of the file is the **AC3
fixture table**: the five canonical scenarios (CI-pass, CI-fail, CI-pending,
secret-detected, deleted-file-in-use) each asserted to produce the SAME verdict
through BOTH harnesses' entrypoints, because both now route through the single
:func:`agentrail.guardrails.policies.objective.evaluate_objective`.

Why one table, two harnesses
----------------------------
The async (``afk``) harness's natural inputs ARE these five scenarios (CI checks +
diff data), so each scenario is expressed directly via ``afk.objective_gate``. The
sync (``run``) harness never supplies CI checks, so for the CI-shaped scenarios we
assert the *unified policy* (the code the run shim calls) returns the expected
verdict for the same inputs — proving there is one definition of done, not two. The
secret / deleted-file scenarios are likewise asserted on the unified policy with an
all-pass sync check-set, proving a security hit reds an otherwise-green sync run.
"""
from __future__ import annotations

import pytest

from agentrail.afk import objective_gate as afk_gate
from agentrail.guardrails import get_guardrail, list_guardrails
from agentrail.guardrails.base import VerdictStatus
from agentrail.guardrails.policies.objective import (
    AcCoverage,
    CheckResult,
    ObjectiveGate,
    evaluate_objective,
)
from agentrail.run import objective_gate as run_gate


def _full_coverage() -> AcCoverage:
    return AcCoverage(total=3, covered=3)


def _passing_checks() -> list[CheckResult]:
    return [
        CheckResult(name="tests", passed=True, detail="42 passed"),
        CheckResult(name="build", passed=True, detail="build ok"),
        CheckResult(name="lint", passed=True, detail="0 issues"),
    ]


# ---------------------------------------------------------------------------
# AC3 fixture table — five scenarios × both harnesses.
#
# Each row: (id, ci_checks, added_lines, deleted_files, references, expected_state)
# expressed in the ASYNC harness's input vocabulary (CI + diff). The expected
# state is the unified tri-state verdict every harness agrees on.
# ---------------------------------------------------------------------------

_ASYNC_FIXTURES = [
    # CI-pass: clean CI, no security issues → pass (merge).
    ("ci_pass", [{"name": "test", "state": "pass"}], [], [], {}, "pass"),
    # CI-fail: a failing check → hard fail.
    ("ci_fail", [{"name": "test", "state": "fail"}], [], [], {}, "fail"),
    # CI-pending: a still-running check → hold (pending, not merge, not fail).
    ("ci_pending", [{"name": "test", "state": "pending"}], [], [], {}, "pending"),
    # secret-detected: CI clean but a committed secret in the diff → fail.
    (
        "secret_detected",
        [{"name": "test", "state": "pass"}],
        ["-----BEGIN RSA PRIVATE KEY-----"],
        [],
        {},
        "fail",
    ),
    # deleted-file-in-use: CI clean but a deleted file is still referenced → fail.
    (
        "deleted_file_in_use",
        [{"name": "test", "state": "pass"}],
        [],
        ["src/util/helper.py"],
        {"src/util/helper.py": ["src/app.py"]},
        "fail",
    ),
]


@pytest.mark.parametrize(
    "scenario, ci, added, deleted, refs, expected",
    _ASYNC_FIXTURES,
    ids=[row[0] for row in _ASYNC_FIXTURES],
)
def test_async_harness_returns_expected_verdict(
    scenario, ci, added, deleted, refs, expected
) -> None:
    """ASYNC (``afk``) harness: each fixture returns the expected tri-state verdict."""
    result = afk_gate.evaluate(
        checks=ci, added_lines=added, deleted_files=deleted, references=refs
    )
    assert result.state == expected, scenario
    assert result.passed is (expected == "pass")


@pytest.mark.parametrize(
    "scenario, ci, added, deleted, refs, expected",
    _ASYNC_FIXTURES,
    ids=[row[0] for row in _ASYNC_FIXTURES],
)
def test_unified_policy_returns_expected_verdict_for_both_harnesses(
    scenario, ci, added, deleted, refs, expected
) -> None:
    """The SAME inputs through the unified policy (what BOTH harnesses call) — one
    definition of done. The sync harness routes its own inputs through this exact
    function, so a single source of truth produces the verdict for both."""
    verdict = evaluate_objective(
        ci_checks=ci, added_lines=added, deleted_files=deleted, references=refs
    )
    assert verdict.state == expected, scenario


# ---------------------------------------------------------------------------
# The SYNC harness's own vocabulary for the same five outcomes — proving the
# unified gate reds/greens a run-harness evaluation identically.
# ---------------------------------------------------------------------------


def test_sync_harness_pass_when_checks_green_and_ac_covered() -> None:
    """CI-pass analogue: all objective checks pass + AC covered → green/pass."""
    result = run_gate.evaluate(checks=_passing_checks(), ac_coverage=_full_coverage())
    assert result.is_green is True
    assert result.verdict == "green"


def test_sync_harness_fail_when_a_check_fails() -> None:
    """CI-fail analogue: a failing objective check → red/fail."""
    checks = [
        CheckResult(name="tests", passed=False, detail="2 failed"),
        CheckResult(name="build", passed=True),
        CheckResult(name="lint", passed=True),
    ]
    result = run_gate.evaluate(checks=checks, ac_coverage=_full_coverage())
    assert result.is_green is False
    assert "tests" in result.failed_reasons


def test_sync_harness_secret_in_diff_reds_an_otherwise_green_run() -> None:
    """secret-detected: a committed secret reds a run whose checks all pass + AC
    covered — the sync harness shares the async security check via the unified gate."""
    verdict = evaluate_objective(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        added_lines=["-----BEGIN RSA PRIVATE KEY-----"],
    )
    assert verdict.state == "fail"
    assert any("secret" in r.lower() or "key" in r.lower() for r in verdict.failed_reasons)


def test_sync_harness_deleted_file_in_use_reds_an_otherwise_green_run() -> None:
    """deleted-file-in-use: a still-referenced deletion reds an otherwise-green run."""
    verdict = evaluate_objective(
        checks=_passing_checks(),
        ac_coverage=_full_coverage(),
        deleted_files=["src/util/helper.py"],
        references={"src/util/helper.py": ["src/app.py"]},
    )
    assert verdict.state == "fail"
    assert any("helper.py" in r for r in verdict.failed_reasons)


def test_sync_harness_cannot_emit_pending_without_ci_checks() -> None:
    """CI-pending: the sync harness supplies no CI checks, so it can only ever
    reach pass/fail — never the async-only pending hold (behaviour preserved)."""
    result = run_gate.evaluate(checks=_passing_checks(), ac_coverage=_full_coverage())
    assert result.state in {"pass", "fail"}
    assert result.state != "pending"


# ---------------------------------------------------------------------------
# CI short-circuit + ordering invariants carried from the async gate (no false-green).
# ---------------------------------------------------------------------------


def test_ci_fail_short_circuits_before_security_and_pending() -> None:
    """A CI fail wins over a still-pending check AND over a security hit — the gate
    returns immediately on the CI fail (the stricter, no-false-green ordering)."""
    verdict = evaluate_objective(
        ci_checks=[
            {"name": "test", "state": "fail"},
            {"name": "build", "state": "pending"},
        ],
        added_lines=["-----BEGIN RSA PRIVATE KEY-----"],
    )
    assert verdict.state == "fail"
    assert any("test" in r for r in verdict.failed_reasons)
    # build (pending) is not reported because the fail short-circuits.
    assert not any("build" in r for r in verdict.failed_reasons)


def test_zero_ci_checks_is_fail_not_silent_pass() -> None:
    """No CI signal at all is a FAIL, never a silent pass (ADR 0007 / no false-green)."""
    verdict = evaluate_objective(ci_checks=[])
    assert verdict.state == "fail"
    assert any("no ci checks" in r.lower() for r in verdict.failed_reasons)


# ---------------------------------------------------------------------------
# AC1 / AC5 — the unified gate is a single registered guardrail.
# ---------------------------------------------------------------------------


def test_objective_gate_is_registered() -> None:
    names = {g.name for g in list_guardrails()}
    assert "objective_gate" in names


def test_registered_objective_gate_maps_states_to_verdict() -> None:
    gate = get_guardrail("objective_gate")
    assert isinstance(gate, ObjectiveGate)
    # pass → PASS
    assert gate.evaluate(
        ci_checks=[{"name": "t", "state": "pass"}]
    ).status is VerdictStatus.PASS
    # fail → FAIL
    assert gate.evaluate(
        ci_checks=[{"name": "t", "state": "fail"}]
    ).status is VerdictStatus.FAIL
    # pending → ADVISORY (a hold, surfaced but not a hard FAIL)
    assert gate.evaluate(
        ci_checks=[{"name": "t", "state": "pending"}]
    ).status is VerdictStatus.ADVISORY


# ---------------------------------------------------------------------------
# AC4 — the old module paths carry NO duplicated decision logic (shims only).
# ---------------------------------------------------------------------------


def test_shims_delegate_to_unified_types() -> None:
    """The run shim's GateResult is the unified verdict; both shims' decision
    functions are the unified ones (no copied logic)."""
    from agentrail.guardrails.policies.objective import ObjectiveVerdict

    assert run_gate.GateResult is ObjectiveVerdict
    # The async shim's evaluate_ci / scan_secrets / deleted_files_in_use are the
    # unified functions (re-exported), not re-implementations.
    from agentrail.guardrails.policies import objective as unified

    assert afk_gate.scan_secrets is unified.scan_secrets
    assert afk_gate.deleted_files_in_use is unified.deleted_files_in_use
    assert afk_gate.fix_prompt is unified.fix_prompt
