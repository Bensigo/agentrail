"""Tests for the OBJECTIVE check-runner (issue #769, AC2 wiring).

The check-runner is the missing OBJECTIVE half of the Objective Gate: it reads
the declared verification command(s) from ``.agentrail/config.json`` (the new
``verify`` key) and RUNS them itself via subprocess. It never trusts the agent's
self-report — exit code 0 means passed, anything else failed (ADR 0007).

The pure parts (parsing config → check specs; mapping exit code → CheckResult;
computing AcCoverage from the declared checks) are unit-tested here in isolation.
The subprocess execution is exercised with trivial real commands (``true`` /
``false``) so the I/O seam is covered behaviorally without mocking.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agentrail.run.check_runner import (
    VerifyCheck,
    ac_coverage_for,
    exit_code_to_check_result,
    parse_verify_config,
    red_green_proof_required,
    run_objective_checks,
)
from agentrail.run.objective_gate import AcCoverage, CheckResult


class ParseVerifyConfigTest(unittest.TestCase):
    """parse_verify_config: config dict → list[VerifyCheck] (pure)."""

    def test_string_becomes_one_check(self) -> None:
        checks = parse_verify_config({"verify": "pytest -q"})
        self.assertEqual(checks, [VerifyCheck(name="verify", command="pytest -q")])

    def test_list_of_objects_becomes_n_checks(self) -> None:
        checks = parse_verify_config(
            {
                "verify": [
                    {"name": "tests", "command": "pytest -q"},
                    {"name": "lint", "command": "ruff check ."},
                ]
            }
        )
        self.assertEqual(
            checks,
            [
                VerifyCheck(name="tests", command="pytest -q"),
                VerifyCheck(name="lint", command="ruff check ."),
            ],
        )

    def test_missing_verify_key_is_empty(self) -> None:
        self.assertEqual(parse_verify_config({}), [])

    def test_none_config_is_empty(self) -> None:
        self.assertEqual(parse_verify_config(None), [])

    def test_empty_string_is_empty(self) -> None:
        self.assertEqual(parse_verify_config({"verify": ""}), [])

    def test_empty_list_is_empty(self) -> None:
        self.assertEqual(parse_verify_config({"verify": []}), [])

    def test_list_entry_without_name_falls_back_to_index(self) -> None:
        checks = parse_verify_config({"verify": [{"command": "make test"}]})
        self.assertEqual(checks, [VerifyCheck(name="verify[0]", command="make test")])

    def test_list_entry_without_command_is_skipped(self) -> None:
        checks = parse_verify_config(
            {"verify": [{"name": "tests", "command": "true"}, {"name": "noop"}]}
        )
        self.assertEqual(checks, [VerifyCheck(name="tests", command="true")])


class ExitCodeToCheckResultTest(unittest.TestCase):
    """exit_code_to_check_result: (name, code) → CheckResult (pure)."""

    def test_zero_is_passed(self) -> None:
        result = exit_code_to_check_result("tests", 0)
        self.assertEqual(result.name, "tests")
        self.assertTrue(result.passed)

    def test_nonzero_is_failed(self) -> None:
        result = exit_code_to_check_result("tests", 1)
        self.assertFalse(result.passed)
        self.assertIn("1", result.detail)

    def test_timeout_code_is_failed(self) -> None:
        result = exit_code_to_check_result("tests", 124)
        self.assertFalse(result.passed)
        self.assertIn("timed out", result.detail)


class AcCoverageForTest(unittest.TestCase):
    """ac_coverage_for: declared checks → AcCoverage (pure).

    Coverage is *declared-verification present*, NOT per-AC mapping (deferred to
    the Verifier #782). >=1 declared check → covered==total; none → (0,0) → RED.
    """

    def test_no_checks_is_zero_coverage(self) -> None:
        self.assertEqual(ac_coverage_for([]), AcCoverage(total=0, covered=0))

    def test_one_check_is_fully_covered(self) -> None:
        cov = ac_coverage_for([VerifyCheck(name="verify", command="true")])
        self.assertEqual(cov, AcCoverage(total=1, covered=1))
        self.assertTrue(cov.is_satisfied)

    def test_n_checks_is_n_covered(self) -> None:
        cov = ac_coverage_for(
            [
                VerifyCheck(name="a", command="true"),
                VerifyCheck(name="b", command="true"),
            ]
        )
        self.assertEqual(cov, AcCoverage(total=2, covered=2))


class RunObjectiveChecksTest(unittest.TestCase):
    """run_objective_checks: RUNS the configured commands (subprocess I/O).

    Uses trivial real commands (``true`` / ``false``) so the runner is exercised
    end-to-end without mocking. This is the OBJECTIVE part: it runs the checks
    itself, never trusting a self-report.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.target_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_config(self, payload: dict) -> None:
        cfg = self.target_dir / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def test_passing_command_yields_passed_result(self) -> None:
        self._write_config({"verify": "true"})
        results = run_objective_checks(self.target_dir)
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].passed)

    def test_failing_command_yields_failed_result(self) -> None:
        self._write_config({"verify": "false"})
        results = run_objective_checks(self.target_dir)
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].passed)

    def test_multiple_checks_run_independently(self) -> None:
        self._write_config(
            {"verify": [{"name": "ok", "command": "true"}, {"name": "bad", "command": "false"}]}
        )
        results = run_objective_checks(self.target_dir)
        by_name = {r.name: r for r in results}
        self.assertTrue(by_name["ok"].passed)
        self.assertFalse(by_name["bad"].passed)

    def test_no_config_means_no_checks(self) -> None:
        results = run_objective_checks(self.target_dir)
        self.assertEqual(results, [])

    def test_results_are_checkresults(self) -> None:
        self._write_config({"verify": "true"})
        results = run_objective_checks(self.target_dir)
        self.assertIsInstance(results[0], CheckResult)


class RedGreenProofRequiredDefaultTest(unittest.TestCase):
    """red_green_proof_required: the verification spine is ON BY DEFAULT (MVP).

    The spine is the default unless a caller explicitly opts out with
    ``"redGreenProof": false`` (AC2/AC3).
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.target_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_config(self, payload: dict) -> None:
        cfg = self.target_dir / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def test_no_config_is_on_by_default(self) -> None:
        """No config file at all → spine ON (the gate will then be RED if no
        verify is declared — an honest default, never a silent pass)."""
        self.assertTrue(red_green_proof_required(self.target_dir))

    def test_config_without_flag_is_on_by_default(self) -> None:
        self._write_config({"verify": "true"})
        self.assertTrue(red_green_proof_required(self.target_dir))

    def test_explicit_true_is_on(self) -> None:
        self._write_config({"redGreenProof": True})
        self.assertTrue(red_green_proof_required(self.target_dir))

    def test_null_flag_is_on_by_default(self) -> None:
        self._write_config({"redGreenProof": None})
        self.assertTrue(red_green_proof_required(self.target_dir))

    def test_explicit_false_opts_out(self) -> None:
        """AC3: an explicit ``redGreenProof: false`` is the documented opt-out."""
        self._write_config({"redGreenProof": False})
        self.assertFalse(red_green_proof_required(self.target_dir))


if __name__ == "__main__":
    unittest.main()
