"""Tests for agentrail/run/pipeline.py — run_issue_phase.

Uses unittest + unittest.mock. All external I/O is patched at the
agentrail.run.pipeline.* import names. A minimal .agentrail/state.json
is written so that update_run_state has a real file to operate on.
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch

from agentrail.run.pipeline import RunContext, run_issue_phase


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_target(tmp_dir: str) -> Path:
    """Create a minimal .agentrail/state.json so update_run_state works."""
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    state_path = agentrail_dir / "state.json"
    state_path.write_text(json.dumps({"workflow": {}}))
    return target


def _make_rc(target: Path, run_dir: Path, ralph_path: Path,
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
        ralph_path=ralph_path,
        agent_timeout=1800,
        failed_verification_attempts=0,
    )


def _stub_run_with_timeout(return_code: int, output_text: str = "agent output"):
    """Return a stub for run_with_timeout that writes output_text and returns return_code."""
    def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        _stub.calls.append({
            "argv": argv,
            "cwd": cwd,
            "timeout": timeout,
            "output_file": output_file,
            "stdin_text": stdin_text,
        })
        output_file.write_text(output_text)
        return return_code
    _stub.calls = []
    return _stub


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class PlanPhaseSuccessTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.ralph = ralph
        self.rc = _make_rc(target, run_dir, ralph)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_success_return_value(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0, "my plan text")
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, plan_output = run_issue_phase(self.rc, "plan", 1)

        self.assertEqual(exit_status, 0)
        self.assertEqual(plan_output, "my plan text")

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_creates_phase_directory(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        phase_dir = self.run_dir / "plan"
        self.assertTrue(phase_dir.is_dir())
        self.assertTrue((phase_dir / "prompt.md").is_file())
        self.assertTrue((phase_dir / "output.md").is_file())
        self.assertTrue((phase_dir / "status.json").is_file())
        self.assertTrue((phase_dir / "metadata.json").is_file())

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_status_json_completed(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        status = _read_json(self.run_dir / "plan" / "status.json")
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["phase"], "plan")

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_uses_bash_argv_with_stdin(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        self.assertEqual(len(stub.calls), 1)
        call_info = stub.calls[0]
        self.assertEqual(call_info["argv"][0], "bash")
        self.assertEqual(call_info["argv"][1], "-lc")
        self.assertIsNotNone(call_info["stdin_text"],
                             "plan phase must pass stdin_text to run_with_timeout")
        self.assertEqual(call_info["cwd"], self.target)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_output_captured_from_file(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0, "captured plan")
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            _, plan_output = run_issue_phase(self.rc, "plan", 1)

        self.assertEqual(plan_output, "captured plan")


class ExecutePhaseSuccessTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.ralph = ralph
        self.rc = _make_rc(target, run_dir, ralph)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_success_return_value(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, plan_output = run_issue_phase(
                self.rc, "execute", 1, plan_output="approved plan"
            )

        self.assertEqual(exit_status, 0)
        self.assertEqual(plan_output, "approved plan",
                         "execute phase must not override plan_output")

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_creates_execute_directory(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        phase_dir = self.run_dir / "execute"
        self.assertTrue(phase_dir.is_dir())
        self.assertTrue((phase_dir / "status.json").is_file())
        self.assertTrue((phase_dir / "metadata.json").is_file())

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_uses_ralph_argv(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        call_info = stub.calls[0]
        argv = call_info["argv"]
        self.assertEqual(argv[0], str(self.ralph))
        self.assertIn("--issue", argv)
        self.assertIn("--agent-command", argv)
        self.assertIn("--prefix-prompt-file", argv)
        self.assertEqual(call_info["cwd"], self.target)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_attempt2_uses_execute_2_dir(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 2)

        phase_dir = self.run_dir / "execute-2"
        self.assertTrue(phase_dir.is_dir())


class FailureTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir, ralph)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_failure_returns_nonzero(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(1)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, _ = run_issue_phase(self.rc, "plan", 1)

        self.assertEqual(exit_status, 1)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_failure_status_json_says_failed(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(1)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        status = _read_json(self.run_dir / "plan" / "status.json")
        self.assertEqual(status["status"], "failed")


class TimeoutTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir, ralph)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_timeout_prints_stderr_message(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(124)
        captured = io.StringIO()
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            with patch("sys.stderr", captured):
                run_issue_phase(self.rc, "plan", 1)

        self.assertIn("timed out", captured.getvalue())
        self.assertIn("plan", captured.getvalue())

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_timeout_status_is_failed(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(124)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        status = _read_json(self.run_dir / "plan" / "status.json")
        self.assertEqual(status["status"], "failed")


class VerifierFindingsTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.ralph = ralph
        self.rc = _make_rc(target, run_dir, ralph)
        # Write a verifier findings file
        self.findings_file = Path(self._tmp.name) / "findings.md"
        self.findings_file.write_text("Test coverage missing for foo().")

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_prompt_contains_verifier_findings(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(
                self.rc, "execute", 1,
                verifier_findings_file=str(self.findings_file),
            )

        prompt_text = (self.run_dir / "execute" / "prompt.md").read_text()
        self.assertIn("Verifier findings", prompt_text)
        self.assertIn("Test coverage missing for foo().", prompt_text)


class UpdateRunStateTests(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir, ralph)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.state_mod.update_run_state")
    def test_update_run_state_called_with_start_and_phase(
        self, mock_update, mock_summary, mock_build
    ):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        self.assertTrue(mock_update.called)
        args, kwargs = mock_update.call_args
        # positional: target_dir, event
        self.assertEqual(args[0], self.target)
        self.assertEqual(args[1], "start")
        self.assertEqual(kwargs["phase"], "plan")
        self.assertEqual(kwargs["issue"], 42)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.state_mod.update_run_state")
    def test_update_run_state_called_for_execute_phase(
        self, mock_update, mock_summary, mock_build
    ):
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        args, kwargs = mock_update.call_args
        self.assertEqual(args[1], "start")
        self.assertEqual(kwargs["phase"], "execute")
        self.assertEqual(kwargs["issue"], 42)


class ContextPackSelectionTests(unittest.TestCase):
    """Test context pack selection logic (legacy 6460-6467)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        ralph = target / "ralph-loop"
        self.target = target
        self.run_dir = run_dir
        self.ralph = ralph

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack")
    def test_plan_phase_reuses_run_context_pack_file(self, mock_build, mock_summary):
        """When run_context_pack_file is set, plan phase reuses it without calling build."""
        rc = _make_rc(self.target, self.run_dir, self.ralph,
                      run_context_pack_file="ctx/pack.json")
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(rc, "plan", 1)

        mock_build.assert_not_called()

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="new_pack.json")
    def test_no_run_context_pack_file_calls_build(self, mock_build, mock_summary):
        """When run_context_pack_file is None, build_issue_context_pack is called."""
        rc = _make_rc(self.target, self.run_dir, self.ralph, run_context_pack_file=None)
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(rc, "plan", 1)

        mock_build.assert_called_once_with(self.target, 42, "plan")


if __name__ == "__main__":
    unittest.main()
