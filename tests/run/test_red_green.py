"""Tests for agentrail/run/red_green.py — the Red-Green Proof config seam.

The Test-Author/Implementer role split (M032, ADR 0008, issue #775) is opt-in
via the ``redGreenProof`` flag in ``.agentrail/config.json``. ``red_green_proof_required``
reads that flag and is the single seam the pipeline consults to decide whether
to run the Test-Author role and require a real fail→pass trail.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agentrail.run.objective_gate import CheckResult
from agentrail.run.red_green import red_green_evidence, red_green_proof_required


class RedGreenProofRequiredTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.target = Path(self._tmp.name)
        (self.target / ".agentrail").mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_config(self, data: dict) -> None:
        (self.target / ".agentrail" / "config.json").write_text(json.dumps(data))

    def test_default_false_when_no_config(self) -> None:
        self.assertFalse(red_green_proof_required(self.target))

    def test_default_false_when_flag_absent(self) -> None:
        self._write_config({"verify": "pytest -q"})
        self.assertFalse(red_green_proof_required(self.target))

    def test_true_when_flag_true(self) -> None:
        self._write_config({"redGreenProof": True})
        self.assertTrue(red_green_proof_required(self.target))

    def test_false_when_flag_false(self) -> None:
        self._write_config({"redGreenProof": False})
        self.assertFalse(red_green_proof_required(self.target))

    def test_nested_flag_under_objective_gate(self) -> None:
        """Also honoured when nested under an ``objectiveGate`` config block."""
        self._write_config({"objectiveGate": {"redGreenProof": True}})
        self.assertTrue(red_green_proof_required(self.target))


class RedGreenEvidenceTests(unittest.TestCase):
    """red_green_evidence: a valid trail is RED-before then GREEN-after."""

    def _cr(self, passed: bool):
        return [CheckResult(name="verify", passed=passed)]

    def test_red_then_green_is_valid(self) -> None:
        ev = red_green_evidence(self._cr(False), self._cr(True))
        self.assertTrue(ev["required"])
        self.assertTrue(ev["valid"])

    def test_green_baseline_is_invalid_pre_passing_test(self) -> None:
        """If the 'red' baseline already passed, the test was tautological."""
        ev = red_green_evidence(self._cr(True), self._cr(True))
        self.assertFalse(ev["valid"])

    def test_red_then_still_red_is_invalid(self) -> None:
        ev = red_green_evidence(self._cr(False), self._cr(False))
        self.assertFalse(ev["valid"])

    def test_empty_passes_are_invalid(self) -> None:
        self.assertFalse(red_green_evidence([], [])["valid"])
        self.assertFalse(red_green_evidence(None, None)["valid"])


if __name__ == "__main__":
    unittest.main()
