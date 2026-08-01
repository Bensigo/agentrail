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
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run.objective_gate import AcCoverage, CheckResult, evaluate
from agentrail.run.pipeline import finalize_objective_gate, run_prompt
from agentrail.run import pipeline as pipeline_mod
from agentrail.tests.run.test_pipeline import _make_target, _sentinel


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


# ---------------------------------------------------------------------------
# Arc C — AC Proof Gate: ac_proof_mode() rollout flag (Task 6).
# ---------------------------------------------------------------------------


def test_ac_proof_mode_default_is_observe(monkeypatch, tmp_path):
    monkeypatch.delenv("AGENTRAIL_AC_PROOF_GATE", raising=False)
    assert pipeline_mod.ac_proof_mode(tmp_path) == "observe"


def test_ac_proof_mode_env_beats_config(monkeypatch, tmp_path):
    (tmp_path / ".agentrail").mkdir()
    (tmp_path / ".agentrail" / "config.json").write_text(json.dumps({"acProofGate": "enforce"}))
    monkeypatch.setenv("AGENTRAIL_AC_PROOF_GATE", "off")
    assert pipeline_mod.ac_proof_mode(tmp_path) == "off"
    monkeypatch.delenv("AGENTRAIL_AC_PROOF_GATE")
    assert pipeline_mod.ac_proof_mode(tmp_path) == "enforce"


def test_ac_proof_mode_typo_falls_through(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTRAIL_AC_PROOF_GATE", "enforcee")
    assert pipeline_mod.ac_proof_mode(tmp_path) == "observe"


# ---------------------------------------------------------------------------
# Arc C — ac_evidence.json artifact writer (Task 6).
# ---------------------------------------------------------------------------


def test_write_ac_evidence_merges(tmp_path):
    from agentrail.run.artifacts import write_ac_evidence
    from agentrail.shared.json import read_json
    path = tmp_path / "ac_evidence.json"
    write_ac_evidence(path, mode="observe", issue=7, head_sha="abc",
                      acs=[{"id": "AC1", "text": "a", "status": "unbound", "evidence": []}],
                      unbound=["AC1"], waived=[], unverifiable=[])
    write_ac_evidence(path, mode="observe", issue=7, head_sha="abc",
                      acs=[], unbound=[], waived=[], unverifiable=[
                          {"ac": "AC1", "why_unbound": "x", "what_would_prove_it": "y"}])
    data = read_json(path)
    assert data["mode"] == "observe" and data["unverifiable"][0]["ac"] == "AC1"


# ---------------------------------------------------------------------------
# Arc C — observe-mode end-to-end wiring through run_prompt (Task 6).
#
# NOTE: the closest existing green-path end-to-end fixture that drives
# run_prompt/_run_pipeline through the real Objective Gate is
# ``RunPromptTests`` in ``test_pipeline.py`` (this file's own
# FinalizeObjectiveGateTest above only drives finalize_objective_gate over
# plain inputs, never the pipeline itself). ``_run`` below copies that
# fixture's arrange/act body verbatim (same target/repo setup via the
# imported ``_make_target``/``_sentinel`` helpers, same patch list, same
# sentinel-flip execute stub, same run_prompt call) with one generalization:
# resolution_text is a parameter instead of a hardcoded string, so a
# checkbox AC can be injected for the AC Proof Gate to compute over.
# ---------------------------------------------------------------------------


class AcProofObserveModeTests(unittest.TestCase):
    """Task 6: observe mode emits ac_evidence.json + a non-gating evidence
    line but never flips the verdict; off mode emits nothing."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, resolution_text: str, *, label: str = "ac-proof-gate"):
        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            return (0, "")

        # subprocess.run is patched so a stray gh/git call cannot fetch an
        # issue or a real head sha — mirrors RunPromptTests._run exactly.
        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text"), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   return_value={"resolved": [], "autoSkills": True}), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
             patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_prompt(
                self.target,
                resolution_text,
                label=label,
                agent="claude",
                command="c",
                repo_dir=self.repo,
            )
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, run_dir

    def test_observe_mode_emits_ac_evidence_and_never_flips_verdict(self) -> None:
        with patch.dict(os.environ, {"AGENTRAIL_AC_PROOF_GATE": "observe"}):
            result, run_dir = self._run(
                "Fix the bug.\n\n## Acceptance criteria\n- [ ] It works."
            )

        run_json = json.loads((run_dir / "run.json").read_text())
        # Observe mode changed nothing about the verdict: green here exactly
        # as in the neighboring green-path test (RunPromptTests in
        # test_pipeline.py, test_green_gate_returns_zero) — same fixture,
        # same sentinel-flip, same declared verify check.
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")
        self.assertEqual(result, 0)
        evidence_names = {e["name"] for e in run_json["objectiveGate"]["evidence"]}
        self.assertIn("ac-proof-observe", evidence_names)

        evidence_path = run_dir / "ac_evidence.json"
        self.assertTrue(evidence_path.is_file())
        data = json.loads(evidence_path.read_text())
        self.assertEqual(data["mode"], "observe")
        self.assertEqual(data["acs"][0]["status"], "unbound")

    def test_off_mode_writes_no_artifact(self) -> None:
        with patch.dict(os.environ, {"AGENTRAIL_AC_PROOF_GATE": "off"}):
            result, run_dir = self._run(
                "Fix the bug.\n\n## Acceptance criteria\n- [ ] It works."
            )
        self.assertFalse((run_dir / "ac_evidence.json").exists())


# ---------------------------------------------------------------------------
# Arc C — enforce-mode end-to-end wiring through run_prompt (Task 7).
#
# ``_run`` below copies AcProofObserveModeTests._run above verbatim (itself a
# copy of RunPromptTests._run in test_pipeline.py — same target/repo setup via
# the imported _make_target/_sentinel helpers, same patch list, same
# sentinel-flip execute stub, same run_prompt call). _make_target declares a
# single verify check named "verify" (see its docstring) — bindings below
# target that exact name.
# ---------------------------------------------------------------------------


class AcProofEnforceModeTests(unittest.TestCase):
    """Task 7: enforce is the gate that can fail — an unbound AC blocks done,
    a waived AC counts as covered, and zero parsed ACs leaves the legacy
    declared-check gate completely untouched."""

    _THREE_ACS = (
        "Fix the bug.\n\n"
        "## Acceptance criteria\n"
        "- [ ] First thing works.\n"
        "- [ ] Second thing works.\n"
        "- [ ] Third thing works.\n"
    )

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_agentrail_json(self, name: str, data: dict) -> None:
        (self.target / ".agentrail" / name).write_text(json.dumps(data))

    def _run(self, resolution_text: str, *, label: str = "ac-proof-gate"):
        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            return (0, "")

        # subprocess.run is patched so a stray gh/git call cannot fetch an
        # issue or a real head sha — mirrors RunPromptTests._run exactly.
        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text"), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   return_value={"resolved": [], "autoSkills": True}), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
             patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_prompt(
                self.target,
                resolution_text,
                label=label,
                agent="claude",
                command="c",
                repo_dir=self.repo,
            )
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, run_dir

    def test_enforce_three_acs_two_bindings_cannot_green(self) -> None:
        """AC1 + AC2 are bound to the passing 'verify' check; AC3 has no
        binding at all. Enforce mode must red the gate on the one genuinely
        unbound AC, even though the legacy declared-check coverage (one
        passing 'verify' check) would otherwise be satisfied."""
        self._write_agentrail_json(
            "ac_bindings.json", {"AC1": ["verify"], "AC2": ["verify"]}
        )

        with patch.dict(os.environ, {"AGENTRAIL_AC_PROOF_GATE": "enforce"}):
            result, run_dir = self._run(self._THREE_ACS)

        run_json = json.loads((run_dir / "run.json").read_text())
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")
        self.assertIn(
            "acceptance-criteria unbound: AC3",
            run_json["objectiveGate"]["failedReasons"],
        )
        self.assertNotEqual(result, 0)

        evidence_path = run_dir / "ac_evidence.json"
        self.assertTrue(evidence_path.is_file())
        data = json.loads(evidence_path.read_text())
        self.assertEqual(data["mode"], "enforce")
        self.assertEqual(data["acs"][2]["status"], "unbound")

    def test_enforce_all_bound_and_waived_greens(self) -> None:
        """AC1 + AC2 are bound to the passing 'verify' check; AC3 is waived.
        A waived AC counts as covered without proof, so all three ACs read
        as covered and the gate reaches green — and the waiver itself
        (reason/by/at) is recorded verbatim on the evidence artifact."""
        self._write_agentrail_json(
            "ac_bindings.json", {"AC1": ["verify"], "AC2": ["verify"]}
        )
        waiver = {
            "reason": "manual QA covers this path; no automated hook exists",
            "by": "alice@example.com",
            "at": "2026-07-30T12:00:00Z",
        }
        self._write_agentrail_json("ac_waivers.json", {"AC3": waiver})

        with patch.dict(os.environ, {"AGENTRAIL_AC_PROOF_GATE": "enforce"}):
            result, run_dir = self._run(self._THREE_ACS)

        run_json = json.loads((run_dir / "run.json").read_text())
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")
        self.assertEqual(result, 0)

        evidence_path = run_dir / "ac_evidence.json"
        self.assertTrue(evidence_path.is_file())
        data = json.loads(evidence_path.read_text())
        self.assertEqual(data["waived"][0]["id"], "AC3")
        self.assertEqual(data["waived"][0]["reason"], waiver["reason"])
        self.assertEqual(data["waived"][0]["by"], waiver["by"])
        self.assertEqual(data["waived"][0]["at"], waiver["at"])

    def test_enforce_zero_acs_keeps_legacy_behavior(self) -> None:
        """No Acceptance-criteria section at all -> parse_acceptance_criteria
        returns []. Enforce mode must not touch the verdict in this case: per
        pipeline.py, ac_coverage_detail is only ever handed to evaluate() when
        `ac_mode == "enforce" and ac_texts` — an empty ac_texts keeps it None,
        so the legacy declared-check coverage is the sole decider, exactly as
        in AcProofObserveModeTests.test_observe_mode_emits_ac_evidence_and_never_flips_verdict
        and RunPromptTests.test_green_gate_returns_zero (both green on this
        same sentinel-flip fixture). The evidence artifact is still written
        (every non-off run gets one, spec Sec1) but honestly empty."""
        with patch.dict(os.environ, {"AGENTRAIL_AC_PROOF_GATE": "enforce"}):
            result, run_dir = self._run("Fix the bug. No checklist section here.")

        run_json = json.loads((run_dir / "run.json").read_text())
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")
        self.assertEqual(result, 0)

        evidence_path = run_dir / "ac_evidence.json"
        self.assertTrue(evidence_path.is_file())
        data = json.loads(evidence_path.read_text())
        self.assertEqual(data["acs"], [])


if __name__ == "__main__":
    unittest.main()
