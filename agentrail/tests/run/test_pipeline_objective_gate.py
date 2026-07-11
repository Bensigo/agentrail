"""Tests for pipeline wiring of the Objective Gate (issue #769, AC2 + AC3).

The pipeline marks a run "done" based on the **Objective Gate** verdict — not on
an LLM reviewer's opinion (ADR 0007). LLM review output is recorded as advisory
and is non-blocking: a clean review can never turn a red gate green, and a
critical review can never turn a green gate red. The gate verdict + evidence are
persisted to the run surface (AC3 data side).

These tests drive the thin orchestration ``finalize_objective_gate`` over plain
inputs; no real tools run.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agentrail.run.objective_gate import AcCoverage, CheckResult, evaluate
from agentrail.run.pipeline import finalize_objective_gate


def _green_result():
    return evaluate(
        checks=[
            CheckResult(name="tests", passed=True),
            CheckResult(name="build", passed=True),
            CheckResult(name="lint", passed=True),
        ],
        ac_coverage=AcCoverage(total=2, covered=2),
    )


def _red_result():
    return evaluate(
        checks=[
            CheckResult(name="tests", passed=False, detail="1 failed"),
            CheckResult(name="build", passed=True),
            CheckResult(name="lint", passed=True),
        ],
        ac_coverage=AcCoverage(total=2, covered=2),
    )


class FinalizeObjectiveGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.run_dir = Path(self._tmp.name) / "run"
        self.run_dir.mkdir(parents=True)
        self.metadata_file = self.run_dir / "run.json"
        self.metadata_file.write_text(json.dumps({"targetIssue": 42}))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # --- AC2: done is decided by the gate, not the review --------------------

    def test_green_gate_marks_done_regardless_of_review(self) -> None:
        outcome = finalize_objective_gate(
            self.metadata_file,
            gate_result=_green_result(),
            review_advisory={"blocking": ["P1: looks risky"]},
        )
        self.assertTrue(outcome["done"])

    def test_red_gate_is_not_done_even_with_clean_review(self) -> None:
        outcome = finalize_objective_gate(
            self.metadata_file,
            gate_result=_red_result(),
            review_advisory={"blocking": [], "advisory": []},
        )
        self.assertFalse(outcome["done"])

    def test_review_findings_do_not_change_doneness(self) -> None:
        """Same gate verdict → same done-ness, whatever the review says."""
        clean = finalize_objective_gate(
            self.metadata_file, gate_result=_green_result(), review_advisory={"blocking": []}
        )
        blocking = finalize_objective_gate(
            self.metadata_file,
            gate_result=_green_result(),
            review_advisory={"blocking": ["P0: scary"]},
        )
        self.assertEqual(clean["done"], blocking["done"])
        self.assertTrue(clean["done"])

    # --- AC2: review stored as advisory --------------------------------------

    def test_review_stored_as_advisory_non_blocking(self) -> None:
        review = {"blocking": ["P1: x"], "advisory": ["P3: nit"]}
        finalize_objective_gate(
            self.metadata_file, gate_result=_green_result(), review_advisory=review
        )
        data = json.loads(self.metadata_file.read_text())
        self.assertIn("review", data)
        self.assertEqual(data["review"]["role"], "advisory")
        # the original findings are preserved verbatim under the advisory record
        self.assertEqual(data["review"]["findings"], review)

    def test_runs_with_no_review_still_finalize(self) -> None:
        outcome = finalize_objective_gate(
            self.metadata_file, gate_result=_green_result(), review_advisory=None
        )
        self.assertTrue(outcome["done"])
        data = json.loads(self.metadata_file.read_text())
        self.assertEqual(data["objectiveGate"]["verdict"], "green")

    # --- AC3 (data side): gate verdict + evidence persisted ------------------

    def test_gate_verdict_persisted_to_run_metadata(self) -> None:
        finalize_objective_gate(
            self.metadata_file, gate_result=_green_result(), review_advisory=None
        )
        data = json.loads(self.metadata_file.read_text())
        self.assertEqual(data["objectiveGate"]["verdict"], "green")
        self.assertTrue(data["objectiveGate"]["isGreen"])

    def test_red_gate_evidence_names_failure(self) -> None:
        finalize_objective_gate(
            self.metadata_file, gate_result=_red_result(), review_advisory=None
        )
        data = json.loads(self.metadata_file.read_text())
        self.assertEqual(data["objectiveGate"]["verdict"], "red")
        self.assertIn("tests", data["objectiveGate"]["failedReasons"])

    def test_evidence_trail_persisted(self) -> None:
        finalize_objective_gate(
            self.metadata_file, gate_result=_green_result(), review_advisory=None
        )
        data = json.loads(self.metadata_file.read_text())
        names = {e["name"] for e in data["objectiveGate"]["evidence"]}
        self.assertIn("tests", names)
        self.assertIn("acceptance-criteria", names)

    def test_preserves_existing_metadata_keys(self) -> None:
        finalize_objective_gate(
            self.metadata_file, gate_result=_green_result(), review_advisory=None
        )
        data = json.loads(self.metadata_file.read_text())
        self.assertEqual(data["targetIssue"], 42)


if __name__ == "__main__":
    unittest.main()
