"""Tests for the eval layer toggles wired into the run pipeline.

The eval harness (``agentrail.evals``) sets ``AGENTRAIL_EVAL_LAYER_<NAME>`` to
``"0"``/``"1"`` for the five layers (CONTEXT, ROUTING, VERIFY_GATE, RETRY,
GUARDRAILS). These tests prove each toggle produces an OBSERVABLE behavior
change in the run pipeline, AND — critically — that with NO flag set the
behavior is the full/default one (the real autonomous loop is unchanged).

All external I/O is patched at the ``agentrail.run.pipeline.*`` import names,
mirroring ``tests/run/test_pipeline.py``.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run.pipeline import RunContext, layer_enabled, run_issue, run_issue_phase


# ---------------------------------------------------------------------------
# Helpers (shared shape with tests/run/test_pipeline.py)
# ---------------------------------------------------------------------------

def _make_target(tmp_dir: str) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {_sentinel(target)}"})
    )
    return target


def _sentinel(target: Path) -> Path:
    return target / "impl_done"


def _make_rc(target: Path, run_dir: Path,
             run_context_pack_file=None,
             max_execution_attempts: int = 5) -> RunContext:
    return RunContext(
        target_dir=target,
        repo_dir=target,
        issue=42,
        agent="claude",
        agent_command="claude --dangerously-skip-permissions",
        run_id="run-abc123",
        run_dir=run_dir,
        started_at="2026-06-10T00:00:00Z",
        metadata_file=run_dir / "run.json",
        base_prompt="Do the thing.",
        resolution_text="Fix the bug.\n\n## Acceptance criteria\n- [ ] It works.",
        run_context_pack_file=run_context_pack_file,
        max_execution_attempts=max_execution_attempts,
        agent_timeout=1800,
        failed_verification_attempts=0,
    )


def _stub_run_with_timeout(return_code: int, output_text: str = "agent output"):
    def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        _stub.calls.append({"argv": argv, "stdin_text": stdin_text})
        output_file.write_text(output_text)
        return return_code
    _stub.calls = []
    return _stub


def _clean_env(**overrides):
    """An os.environ patch that starts from a copy with all AGENTRAIL_EVAL_LAYER_*
    removed, then applies the given overrides. So a test asserting the DEFAULT
    (no-flag) behavior is not polluted by an ambient eval env."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")}
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


# ---------------------------------------------------------------------------
# layer_enabled — the single source of truth for flag reads
# ---------------------------------------------------------------------------

class LayerEnabledTests(unittest.TestCase):
    def test_absent_flag_is_on(self):
        with _clean_env():
            self.assertTrue(layer_enabled("CONTEXT"))
            self.assertTrue(layer_enabled("RETRY"))

    def test_explicit_one_is_on(self):
        with _clean_env(AGENTRAIL_EVAL_LAYER_CONTEXT="1"):
            self.assertTrue(layer_enabled("CONTEXT"))

    def test_explicit_zero_is_off(self):
        with _clean_env(AGENTRAIL_EVAL_LAYER_CONTEXT="0"):
            self.assertFalse(layer_enabled("CONTEXT"))

    def test_name_is_case_insensitive(self):
        with _clean_env(AGENTRAIL_EVAL_LAYER_RETRY="0"):
            self.assertFalse(layer_enabled("retry"))
            self.assertFalse(layer_enabled("RETRY"))

    def test_unknown_value_treated_as_on(self):
        # A typo'd flag must never silently disable a layer in the real loop.
        with _clean_env(AGENTRAIL_EVAL_LAYER_CONTEXT="yes"):
            self.assertTrue(layer_enabled("CONTEXT"))


# ---------------------------------------------------------------------------
# CONTEXT — off ⇒ build_issue_context_pack NOT called, context summary empty
# ---------------------------------------------------------------------------

class ContextLayerPhaseTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(self.target, self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUMMARY")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="pack.json")
    def test_context_on_default_builds_pack(self, mock_build, mock_summary):
        stub = _stub_run_with_timeout(0)
        with _clean_env(), patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)
        mock_build.assert_called()  # default = ON = today's behavior
        prompt_text = (self.run_dir / "execute" / "prompt.md").read_text()
        self.assertIn("SUMMARY", prompt_text)

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUMMARY")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="pack.json")
    def test_context_off_skips_pack_and_empties_summary(self, mock_build, mock_summary):
        stub = _stub_run_with_timeout(0)
        with _clean_env(AGENTRAIL_EVAL_LAYER_CONTEXT="0"), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)
        mock_build.assert_not_called()
        mock_summary.assert_not_called()
        prompt_text = (self.run_dir / "execute" / "prompt.md").read_text()
        self.assertNotIn("SUMMARY", prompt_text)
        # Metadata records no context pack for the phase.
        meta = json.loads((self.run_dir / "execute" / "metadata.json").read_text())
        self.assertIn(meta.get("contextPackFile"), (None, "", "null"))


# ---------------------------------------------------------------------------
# GUARDRAILS — off ⇒ output-format enforcement skipped (no rejection event)
# ---------------------------------------------------------------------------

class GuardrailsLayerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(self.target, self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="")
    @patch("agentrail.run.pipeline.enforce")
    def test_guardrails_on_default_runs_enforcement(self, mock_enforce, *_):
        mock_enforce.return_value = MagicMock()  # Accepted-ish; isinstance(Rejected) False
        stub = _stub_run_with_timeout(0)
        with _clean_env(), patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)
        mock_enforce.assert_called()  # default = ON = today's behavior

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="")
    @patch("agentrail.run.pipeline.enforce")
    def test_guardrails_off_skips_enforcement(self, mock_enforce, *_):
        stub = _stub_run_with_timeout(0)
        with _clean_env(AGENTRAIL_EVAL_LAYER_GUARDRAILS="0"), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)
        mock_enforce.assert_not_called()


# ---------------------------------------------------------------------------
# run_issue-level toggles: RETRY, VERIFY_GATE, CONTEXT (base prompt)
# ---------------------------------------------------------------------------

def _run_issue_with_phase_stub(target, repo, phase_stub, phase_commands=None, env=None):
    """Drive run_issue with all collaborators patched, returning (result, captured)."""
    captured = {"max_attempts": [], "phases": []}

    def _wrapped(rc, phase, attempt, verifier_findings_file="", plan_output=""):
        captured["max_attempts"].append(rc.max_execution_attempts)
        captured["phases"].append(phase)
        return phase_stub(rc, phase, attempt, verifier_findings_file, plan_output)

    gh_mock = MagicMock()
    gh_mock.returncode = 1
    gh_mock.stdout = ""

    env_ctx = _clean_env(**(env or {}))
    with env_ctx, \
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
         patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP") as mock_base, \
         patch("agentrail.run.pipeline.run_issue_phase", side_effect=_wrapped), \
         patch("agentrail.run.pipeline.state_mod.update_run_state"), \
         patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
         patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
        result = run_issue(target, 7, agent="claude", command="c", repo_dir=repo,
                           phase_commands=phase_commands)
    captured["base_prompt_kwargs"] = mock_base.call_args.kwargs
    return result, captured


class RetryLayerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, rc, phase, attempt, vff, plan_output):
        if phase == "execute":
            _sentinel(self.target).write_text("x")
        return (0, "")

    def test_retry_on_default_uses_configured_max_attempts(self):
        # Default (no flag) = ON = configured value (5). Real-loop unchanged.
        _, cap = _run_issue_with_phase_stub(self.target, self.repo, self._phase)
        self.assertTrue(all(m == 5 for m in cap["max_attempts"]))

    def test_retry_off_forces_single_attempt(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase,
            env={"AGENTRAIL_EVAL_LAYER_RETRY": "0"},
        )
        self.assertTrue(cap["max_attempts"], "phases must have run")
        self.assertTrue(all(m == 1 for m in cap["max_attempts"]))


class ContextLayerBasePromptTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, rc, phase, attempt, vff, plan_output):
        if phase == "execute":
            _sentinel(self.target).write_text("x")
        return (0, "")

    def test_context_on_default_injects_summary_and_snippets(self):
        _, cap = _run_issue_with_phase_stub(self.target, self.repo, self._phase)
        kw = cap["base_prompt_kwargs"]
        self.assertEqual(kw["context_summary"], "SUMMARY")
        self.assertEqual(kw["context_snippets"], "SNIPPETS")

    def test_context_off_empties_base_prompt_context(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase,
            env={"AGENTRAIL_EVAL_LAYER_CONTEXT": "0"},
        )
        kw = cap["base_prompt_kwargs"]
        self.assertEqual(kw["context_summary"], "")
        self.assertEqual(kw["context_snippets"], "")


class VerifyGateLayerTests(unittest.TestCase):
    """VERIFY_GATE off ⇒ the Independent Verifier phase does NOT run, even when a
    distinct-model verify command is configured."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, rc, phase, attempt, vff, plan_output):
        if phase == "execute":
            _sentinel(self.target).write_text("x")
        # Provide a verify output so the verify branch (if it runs) is well-formed.
        if phase == "verify":
            vdir = rc.run_dir / "verify"
            vdir.mkdir(parents=True, exist_ok=True)
            (vdir / "output.md").write_text("VERDICT: accept")
        return (0, "")

    def test_verify_gate_on_default_runs_verify_phase(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase,
            phase_commands={"verify": "claude --model other"},
        )
        self.assertIn("verify", cap["phases"])  # default = ON = today's behavior

    def test_verify_gate_off_skips_verify_phase(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase,
            phase_commands={"verify": "claude --model other"},
            env={"AGENTRAIL_EVAL_LAYER_VERIFY_GATE": "0"},
        )
        self.assertNotIn("verify", cap["phases"])
        # The implementer phases still run; only the verifier is gated out.
        self.assertIn("execute", cap["phases"])


# ---------------------------------------------------------------------------
# ROUTING — honest documentation test.
#
# The run-prompt path the eval drives (run_issue/_run_pipeline) runs a SINGLE
# pinned model end-to-end with NO escalation/tier-bumping (model escalation lives
# in the AFK runner queue, agentrail/afk/queue_state.py, a different harness).
# So ROUTING off is a no-op in this path: the single-model behavior is identical
# with or without the flag. We assert that explicitly rather than fake a toggle.
# ---------------------------------------------------------------------------

class RoutingLayerNoLiveHookTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, rc, phase, attempt, vff, plan_output):
        if phase == "execute":
            _sentinel(self.target).write_text("x")
        return (0, "")

    def test_routing_off_runs_identically_single_model(self):
        # With ROUTING off, the pipeline still runs the same single execute phase
        # (no escalation exists to disable). Commands seen are unchanged.
        result_on, cap_on = _run_issue_with_phase_stub(self.target, self.repo, self._phase)
        # Reset sentinel between runs.
        _sentinel(self.target).unlink(missing_ok=True)
        result_off, cap_off = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase,
            env={"AGENTRAIL_EVAL_LAYER_ROUTING": "0"},
        )
        self.assertEqual(cap_on["phases"], cap_off["phases"])
        self.assertEqual(result_on, result_off)


if __name__ == "__main__":
    unittest.main()
