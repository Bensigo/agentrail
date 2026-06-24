"""Pipeline wiring for the Critic seam (issue #977).

The Critic is the cheap-model independent reviewer that REPLACES the expensive
verify model as the reviewer feeding the Objective Gate. These tests prove the
``AGENTRAIL_EVAL_LAYER_CRITIC`` toggle controls which reviewer runs, that the
critic is a SEPARATE phase from the executor (AC3), and that a critic REJECT
blocks "done" exactly as a verify reject does today (AC2/AC3).

Layer semantics (AC4): the critic only runs when a distinct ``critic`` command is
configured AND ``AGENTRAIL_EVAL_LAYER_CRITIC`` is not explicitly ``"0"``. With no
critic command configured (the real loop) the verify path runs unchanged.
"""
from __future__ import annotations

import json
import os
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
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {target / 'impl_done'}"})
    )
    return target


def _sentinel(target: Path) -> Path:
    return target / "impl_done"


def _clean_env(**overrides):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")}
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


def _run_issue_with_phase_stub(target, repo, phase_stub, phase_commands=None, env=None):
    captured = {"phases": []}

    def _wrapped(rc, phase, attempt, verifier_findings_file="", plan_output=""):
        captured["phases"].append(phase)
        return phase_stub(rc, phase, attempt, verifier_findings_file, plan_output)

    gh_mock = MagicMock()
    gh_mock.returncode = 1
    gh_mock.stdout = ""

    with _clean_env(**(env or {})), \
         patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
         patch("agentrail.run.pipeline.skills.resolve_skills",
               return_value={"resolved": [], "autoSkills": True}), \
         patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="pack.json"), \
         patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUMMARY"), \
         patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value="SNIPPETS"), \
         patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
         patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
         patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
         patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
         patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
         patch("agentrail.run.pipeline.run_issue_phase", side_effect=_wrapped), \
         patch("agentrail.run.pipeline.state_mod.update_run_state"), \
         patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
         patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
        result = run_issue(target, 7, agent="claude", command="c", repo_dir=repo,
                           phase_commands=phase_commands)
    return result, captured


class CriticReplacesVerifyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, verdict_text):
        def _p(rc, phase, attempt, vff, plan_output):
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            if phase in ("verify", "critic"):
                vdir = rc.run_dir / phase
                vdir.mkdir(parents=True, exist_ok=True)
                (vdir / "output.md").write_text(verdict_text)
            return (0, "")
        return _p

    # --- AC2/AC3: when a critic command is configured, the CRITIC runs instead
    #     of the verify phase, and feeds the gate. -----------------------------

    def test_critic_runs_instead_of_verify_when_configured(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase('VERDICT: {"verdict":"accept","reason":"ok"}'),
            phase_commands={"verify": "claude --model expensive",
                            "critic": "claude --model cheap"},
        )
        # The cheap critic is the independent reviewer — the expensive verify phase
        # is NOT run when the critic replaces it.
        self.assertIn("critic", cap["phases"])
        self.assertNotIn("verify", cap["phases"])
        # AC3: the executor still runs as a SEPARATE phase before the critic.
        self.assertIn("execute", cap["phases"])
        self.assertLess(cap["phases"].index("execute"), cap["phases"].index("critic"))

    def test_critic_reject_blocks_done(self):
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase('VERDICT: {"verdict":"reject","reason":"gamed"}'),
            phase_commands={"verify": "claude --model expensive",
                            "critic": "claude --model cheap"},
        )
        self.assertIn("critic", cap["phases"])
        # A critic reject blocks done exactly as a verify reject does today.
        self.assertNotEqual(result, 0)

    def test_critic_accept_allows_done(self):
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase('VERDICT: {"verdict":"accept","reason":"ok"}'),
            phase_commands={"critic": "claude --model cheap"},
        )
        self.assertIn("critic", cap["phases"])
        self.assertEqual(result, 0)

    # --- AC4: layer OFF -> byte-identical to today's verify path. -------------

    def test_critic_off_falls_back_to_verify(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase('VERDICT: {"verdict":"accept","reason":"ok"}'),
            phase_commands={"verify": "claude --model expensive",
                            "critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_CRITIC": "0"},
        )
        # With the critic layer OFF, the expensive verify phase runs (today's path)
        # and the critic does NOT.
        self.assertIn("verify", cap["phases"])
        self.assertNotIn("critic", cap["phases"])

    def test_no_critic_configured_runs_verify(self):
        """The real loop builds no critic command -> verify path is unchanged."""
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase('VERDICT: {"verdict":"accept","reason":"ok"}'),
            phase_commands={"verify": "claude --model expensive"},
        )
        self.assertIn("verify", cap["phases"])
        self.assertNotIn("critic", cap["phases"])


if __name__ == "__main__":
    unittest.main()
