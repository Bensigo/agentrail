"""Best-of-N execute with critic ranking and early stop (issue #979).

The best-of-N layer turns the blind single-execute into a *critic-gated attempt
loop with early stopping*: the execute phase produces up to a small configurable
``N`` candidate fixes, the independent Critic (#977) scores each one, the
highest-scoring candidate is carried to the Objective Gate, and generation STOPS
EARLY the moment a candidate clears the critic's confidence bar.

These tests prove the four ACs against the real ``_run_pipeline`` body:

- AC1: with the layer ON, execute can run up to N times and the Critic ranks
  each candidate.
- AC2: the best-scoring candidate is selected and an early ACCEPT stops
  generation before N candidates are produced.
- AC3: generation is bounded by N (never exceeds it) and the selected
  candidate's verdict is the evidence fed to the gate.
- AC4: behind ``AGENTRAIL_EVAL_LAYER_BESTOFN`` via ``layer_enabled`` — OFF is
  byte-identical to today (single execute + the existing critic/verify gate).

All external I/O is patched at the ``agentrail.run.pipeline.*`` import names,
mirroring ``tests/run/test_critic_pipeline.py``.
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
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")
           and k != "AGENTRAIL_BESTOFN_N"}
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


def _run_issue_with_phase_stub(target, repo, phase_stub, phase_commands=None, env=None):
    """Drive run_issue with run_issue_phase stubbed, recording the phase sequence.

    The wrapper records ``(phase, attempt)`` for every phase invocation so a test
    can assert how many candidates the execute/critic loop produced and in what
    order.
    """
    captured = {"phases": [], "execute_attempts": [], "critic_attempts": []}

    def _wrapped(rc, phase, attempt, verifier_findings_file="", plan_output=""):
        captured["phases"].append(phase)
        if phase == "execute":
            captured["execute_attempts"].append(attempt)
        if phase == "critic":
            captured["critic_attempts"].append(attempt)
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


class BestOfNTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase_with_verdicts(self, verdicts):
        """Build a phase stub whose critic emits the verdict for each candidate.

        ``verdicts`` is a list of "accept"/"reject" strings indexed by the
        critic attempt number (1-based). Every execute writes the sentinel so the
        Objective Gate's declared check passes.
        """
        def _p(rc, phase, attempt, vff, plan_output):
            if phase == "execute":
                _sentinel(self.target).write_text(f"candidate-{attempt}")
            if phase == "critic":
                vdir = rc.run_dir / (phase if attempt <= 1 else f"{phase}-{attempt}")
                vdir.mkdir(parents=True, exist_ok=True)
                v = verdicts[min(attempt, len(verdicts)) - 1]
                (vdir / "output.md").write_text(
                    f'VERDICT: {{"verdict":"{v}","reason":"{v}-{attempt}"}}'
                )
            return (0, "")
        return _p

    # --- AC1/AC2: an early accept stops generation before N candidates. -------

    def test_early_accept_stops_after_first_candidate(self):
        # N=3, but the FIRST candidate is accepted → only one execute+critic pair.
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["accept", "accept", "accept"]),
            phase_commands={"critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "1", "AGENTRAIL_BESTOFN_N": "3"},
        )
        self.assertEqual(result, 0)
        self.assertEqual(cap["execute_attempts"], [1])
        self.assertEqual(cap["critic_attempts"], [1])

    # --- AC1/AC3: keep generating up to N while the critic rejects. -----------

    def test_generates_up_to_n_when_all_rejected(self):
        # Every candidate is rejected → exactly N execute+critic pairs, no more.
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["reject", "reject", "reject"]),
            phase_commands={"critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "1", "AGENTRAIL_BESTOFN_N": "3"},
        )
        # All rejected → the gate refuses GREEN (a reject blocks done).
        self.assertNotEqual(result, 0)
        self.assertEqual(cap["execute_attempts"], [1, 2, 3])
        self.assertEqual(len(cap["critic_attempts"]), 3)

    def test_never_exceeds_n(self):
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["reject", "reject"]),
            phase_commands={"critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "1", "AGENTRAIL_BESTOFN_N": "2"},
        )
        self.assertLessEqual(len(cap["execute_attempts"]), 2)
        self.assertLessEqual(len(cap["critic_attempts"]), 2)

    # --- AC2: a later candidate that passes is the one carried forward. -------

    def test_later_accept_is_selected_and_stops(self):
        # reject, reject, accept → three candidates, the third (accept) wins.
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["reject", "reject", "accept"]),
            phase_commands={"critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "1", "AGENTRAIL_BESTOFN_N": "3"},
        )
        self.assertEqual(result, 0)
        self.assertEqual(cap["execute_attempts"], [1, 2, 3])

    # --- AC4: layer OFF -> single execute, no extra candidates. ---------------

    def test_layer_off_runs_single_execute(self):
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["accept"]),
            phase_commands={"critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "0"},
        )
        # OFF: exactly one execute, and the existing single critic gate runs once.
        self.assertEqual(cap["execute_attempts"], [1])
        self.assertEqual(cap["critic_attempts"], [1])
        self.assertEqual(result, 0)

    def test_layer_off_reject_blocks_like_today(self):
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["reject"]),
            phase_commands={"critic": "claude --model cheap"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "0"},
        )
        self.assertEqual(cap["execute_attempts"], [1])
        self.assertNotEqual(result, 0)

    # --- AC4: best-of-N requires a critic; with no critic it is single-shot. --

    def test_no_critic_command_runs_single_execute(self):
        # The real loop builds no critic command → best-of-N cannot rank, so the
        # execute phase runs exactly once (today's behavior), even with the flag.
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo,
            self._phase_with_verdicts(["accept"]),
            phase_commands={"verify": "claude --model expensive"},
            env={"AGENTRAIL_EVAL_LAYER_BESTOFN": "1", "AGENTRAIL_BESTOFN_N": "3"},
        )
        self.assertEqual(cap["execute_attempts"], [1])
        # The verify gate still runs as today.
        self.assertIn("verify", cap["phases"])
        self.assertNotIn("critic", cap["phases"])


if __name__ == "__main__":
    unittest.main()
