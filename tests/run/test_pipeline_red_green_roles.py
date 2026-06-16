"""Pipeline integration for the Test-Author/Implementer role split (M032, #775).

When the opt-in ``redGreenProof`` flag is set, ``run_issue`` runs a DISTINCT
Test-Author phase BEFORE the Implementer (execute) phase. The Test-Author
authors a *failing* acceptance test (observed RED on the baseline check run);
the Implementer's change turns it GREEN. The two are different roles — the
implementer never authors its own acceptance test.

These tests are hermetic: a stub ``run_with_timeout`` records phase order and
flips the declared verify check from failing (before implementation) to passing
(after). No real agent, gh, network, or DB.

Acceptance criteria (issue #775):
  AC1 — Test-Author produces a FAILING acceptance test BEFORE implementation.
  AC2 — the Implementer's change turns that test GREEN.
  AC3 — authorship and implementation are DISTINCT roles.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run.pipeline import run_issue


def _make_target(tmp_dir: str) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    # Opt-in to the role split + declare a verify check whose result the stub
    # controls (red before implementation, green after).
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": "true", "redGreenProof": True})
    )
    return target


class _Harness:
    """Drives run_issue with stubbed phase execution and a controllable
    objective-check result that flips red→green when the Implementer runs."""

    def __init__(self, target: Path, repo: Path):
        self.target = target
        self.repo = repo
        self.phase_order: list[str] = []
        self.implemented = False  # set True once the execute (Implementer) phase runs

    def _phase_stub(self, rc, phase, attempt, verifier_findings_file="", plan_output=""):
        self.phase_order.append(phase)
        if phase == "execute":
            self.implemented = True
        if phase == "plan":
            return (0, "PLAN OUT")
        return (0, "")

    def _objective_checks(self, target_dir, **kwargs):
        # Mirror the real check_runner contract: one CheckResult per declared
        # check. The acceptance test fails until the Implementer has run.
        from agentrail.run.objective_gate import CheckResult
        return [CheckResult(name="verify", passed=self.implemented,
                            detail="green" if self.implemented else "red")]

    def run(self):
        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""
        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T\n## Acceptance criteria\n- [ ] works"), \
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=self._phase_stub), \
             patch("agentrail.run.pipeline.run_objective_checks", side_effect=self._objective_checks), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 775, agent="claude", command="c", repo_dir=self.repo)
        return result


class RoleSplitPipelineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_test_author_phase_runs_before_execute(self):
        """AC1 + AC3: a distinct test-author phase runs strictly before execute."""
        h = _Harness(self.target, self.repo)
        h.run()
        self.assertIn("test-author", h.phase_order)
        self.assertIn("execute", h.phase_order)
        self.assertLess(
            h.phase_order.index("test-author"),
            h.phase_order.index("execute"),
            "Test-Author must run before the Implementer (execute) phase",
        )

    def test_red_then_green_proof_is_recorded_and_run_is_green(self):
        """AC1 + AC2: red baseline observed before impl, green after; gate green."""
        h = _Harness(self.target, self.repo)
        result = h.run()
        self.assertEqual(result, 0, "run must reach green when the proof is valid")
        run_dir = next((self.target / ".agentrail" / "runs").iterdir())
        gate = json.loads((run_dir / "run.json").read_text())["objectiveGate"]
        self.assertEqual(gate["verdict"], "green")
        names = {e["name"] for e in gate["evidence"]}
        self.assertIn("red-green-proof", names)
        proof = next(e for e in gate["evidence"] if e["name"] == "red-green-proof")
        self.assertTrue(proof["passed"])

    def test_tautological_test_that_never_went_red_fails_the_gate(self):
        """The anti-false-green guard: if the acceptance test already PASSES on
        the baseline (it never went red), the proof is invalid and the gate is
        red even though the final checks pass — this is the false-green ADR 0008
        defeats."""
        h = _Harness(self.target, self.repo)
        # Force the baseline check to pass too (as if the test were tautological /
        # authored to fit pre-existing behaviour): make the check always green.
        h._objective_checks = lambda target_dir, **kw: [
            __import__("agentrail.run.objective_gate", fromlist=["CheckResult"]).CheckResult(
                name="verify", passed=True, detail="green")
        ]
        result = h.run()
        self.assertEqual(result, 1, "a never-red test must not reach green")
        run_dir = next((self.target / ".agentrail" / "runs").iterdir())
        gate = json.loads((run_dir / "run.json").read_text())["objectiveGate"]
        self.assertEqual(gate["verdict"], "red")
        self.assertIn("red-green proof trail invalid", gate["failedReasons"])

    def test_role_split_off_when_flag_absent(self):
        """Default (no redGreenProof flag): no test-author phase; behaviour
        unchanged from the plain plan→execute pipeline."""
        # Rewrite config without the flag.
        (self.target / ".agentrail" / "config.json").write_text(json.dumps({"verify": "true"}))
        h = _Harness(self.target, self.repo)
        # Without the role split the acceptance test never goes red first, so
        # the harness's flip logic is irrelevant; assert no test-author phase.
        h.run()
        self.assertNotIn("test-author", h.phase_order)


class RoleSeparationTests(unittest.TestCase):
    """AC3 at the prompt level: the Implementer is told not to author its own
    acceptance test, while the Test-Author is told not to implement. Drives the
    real run_issue_phase prompt-building (no agent execution)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.run_dir = Path(self._tmp.name) / "run"
        self.run_dir.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _rc(self):
        from agentrail.run.pipeline import RunContext
        return RunContext(
            target_dir=self.target, repo_dir=self.target, issue=775, agent="claude",
            agent_command="c", run_id="r", run_dir=self.run_dir,
            started_at="2026-06-16T00:00:00Z", metadata_file=self.run_dir / "run.json",
            base_prompt="BP", resolution_text="CTX", run_context_pack_file=None,
            max_execution_attempts=5,
        )

    def test_test_author_phase_prompt_forbids_implementation(self):
        from agentrail.run.pipeline import run_issue_phase
        stub_calls = []

        def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
            stub_calls.append(stdin_text)
            output_file.write_text("")
            return 0

        with patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUM"), \
             patch("agentrail.run.pipeline.run_with_timeout", _stub):
            run_issue_phase(self._rc(), "test-author", 1)
        prompt = (self.run_dir / "test-author" / "prompt.md").read_text()
        self.assertIn("Test-Author", prompt)
        self.assertIn("do not implement", prompt.lower())

    def test_implementer_phase_prompt_forbids_authoring_test(self):
        from agentrail.run.pipeline import run_issue_phase

        def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
            output_file.write_text("")
            return 0

        with patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUM"), \
             patch("agentrail.run.pipeline.run_with_timeout", _stub):
            run_issue_phase(self._rc(), "execute", 1, plan_output="PLAN")
        prompt = (self.run_dir / "execute" / "prompt.md").read_text()
        # The role split is active (redGreenProof=True in config), so the
        # implementer prompt must carry the boundary forbidding self-authored tests.
        self.assertIn("Implementer", prompt)
        self.assertIn("Do NOT author", prompt)


if __name__ == "__main__":
    unittest.main()
