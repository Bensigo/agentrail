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

import os

from agentrail.run.pipeline import RunContext, run_issue, run_issue_phase


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
    def test_execute_native_bash_stdin_by_default(self, mock_summary, mock_build):
        """By default (AGENTRAIL_NATIVE_EXECUTE unset), execute runs natively:
        bash -lc <agent_command> with the phase prompt on stdin, mirroring plan."""
        stub = _stub_run_with_timeout(0)
        env = {k: v for k, v in os.environ.items() if k != "AGENTRAIL_NATIVE_EXECUTE"}
        with patch.dict(os.environ, env, clear=True), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        call_info = stub.calls[0]
        argv = call_info["argv"]
        self.assertEqual(argv[0], "bash")
        self.assertEqual(argv[1], "-lc")
        self.assertEqual(argv[2], self.rc.agent_command)
        self.assertIsNotNone(call_info["stdin_text"],
                             "native execute must pass the phase prompt on stdin")
        self.assertNotIn("--issue", argv)
        self.assertEqual(call_info["cwd"], self.target)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_uses_ralph_argv_when_native_disabled(self, mock_summary, mock_build):
        """AGENTRAIL_NATIVE_EXECUTE=0 falls back to the legacy ralph-loop argv."""
        stub = _stub_run_with_timeout(0)
        with patch.dict(os.environ, {"AGENTRAIL_NATIVE_EXECUTE": "0"}), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        call_info = stub.calls[0]
        argv = call_info["argv"]
        self.assertEqual(argv[0], str(self.ralph))
        self.assertIn("--issue", argv)
        self.assertIn("--agent-command", argv)
        self.assertIn("--prefix-prompt-file", argv)
        self.assertIsNone(call_info["stdin_text"],
                          "legacy ralph branch does not pass stdin_text")
        self.assertEqual(call_info["cwd"], self.target)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_timeout_prefers_ralph_agent_timeout(self, mock_summary, mock_build):
        """For the execute phase, RALPH_AGENT_TIMEOUT wins over AGENTRAIL_AGENT_TIMEOUT
        (preserves legacy ralph-loop precedence)."""
        stub = _stub_run_with_timeout(0)
        with patch.dict(os.environ, {
            "RALPH_AGENT_TIMEOUT": "111",
            "AGENTRAIL_AGENT_TIMEOUT": "222",
        }), patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        self.assertEqual(stub.calls[0]["timeout"], 111)

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_timeout_falls_back_to_agentrail_agent_timeout(self, mock_summary, mock_build):
        stub = _stub_run_with_timeout(0)
        env = {k: v for k, v in os.environ.items() if k != "RALPH_AGENT_TIMEOUT"}
        env["AGENTRAIL_AGENT_TIMEOUT"] = "222"
        with patch.dict(os.environ, env, clear=True), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        self.assertEqual(stub.calls[0]["timeout"], 222)

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


# ---------------------------------------------------------------------------
# Hardening tests: three additional assertions for run_issue_phase
# ---------------------------------------------------------------------------

class ExecuteStdinHardeningTests(unittest.TestCase):
    """Hardening #1: EXECUTE phase must NOT pass stdin_text; PLAN phase must pass it."""

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
    def test_execute_does_not_pass_stdin_text(self, mock_summary, mock_build):
        """Legacy ralph branch (AGENTRAIL_NATIVE_EXECUTE=0) must not pass stdin_text."""
        stub = _stub_run_with_timeout(0)
        with patch.dict(os.environ, {"AGENTRAIL_NATIVE_EXECUTE": "0"}), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1, plan_output="approved plan")

        self.assertEqual(len(stub.calls), 1)
        call_info = stub.calls[0]
        self.assertIsNone(
            call_info.get("stdin_text"),
            "legacy execute phase must NOT pass stdin_text to run_with_timeout",
        )

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_passes_stdin_text_legacy_execute_does_not(self, mock_summary, mock_build):
        """Contrast: plan passes stdin_text; legacy execute (NATIVE=0) passes None."""
        # Plan phase
        plan_stub = _stub_run_with_timeout(0, "plan output")
        with patch("agentrail.run.pipeline.run_with_timeout", plan_stub):
            run_issue_phase(self.rc, "plan", 1)
        self.assertIsNotNone(
            plan_stub.calls[0].get("stdin_text"),
            "plan phase must pass a non-None stdin_text",
        )

        # Legacy execute phase (fresh RunContext reusing same dirs is fine — just check stdin)
        exec_stub = _stub_run_with_timeout(0)
        with patch.dict(os.environ, {"AGENTRAIL_NATIVE_EXECUTE": "0"}), \
                patch("agentrail.run.pipeline.run_with_timeout", exec_stub):
            run_issue_phase(self.rc, "execute", 1, plan_output="plan output")
        self.assertIsNone(
            exec_stub.calls[0].get("stdin_text"),
            "legacy execute phase must NOT pass stdin_text",
        )


class ExecuteReusesOnDiskContextPackTests(unittest.TestCase):
    """Hardening #2: EXECUTE phase reuses an on-disk run-level context pack file."""

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
    def test_execute_reuses_ondisk_pack_without_calling_build(self, mock_build, mock_summary):
        """When run_context_pack_file exists on disk, EXECUTE must NOT call build_issue_context_pack
        and must call context_pack_summary with that reused pack path."""
        pack_rel = ".agentrail/context/packs/p.json"
        # Actually create the file so is_file() is True
        pack_abs = self.target / pack_rel
        pack_abs.parent.mkdir(parents=True, exist_ok=True)
        pack_abs.write_text(json.dumps({"pack": "data"}))

        rc = _make_rc(self.target, self.run_dir, self.ralph,
                      run_context_pack_file=pack_rel)
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(rc, "execute", 1)

        mock_build.assert_not_called()
        mock_summary.assert_called_once_with(self.target, pack_rel)

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="built_pack.json")
    def test_execute_calls_build_when_pack_file_does_not_exist(self, mock_build, mock_summary):
        """Contrast: when run_context_pack_file is set but the file does NOT exist on disk,
        build_issue_context_pack IS called."""
        rc = _make_rc(self.target, self.run_dir, self.ralph,
                      run_context_pack_file=".agentrail/context/packs/missing.json")
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(rc, "execute", 1)

        mock_build.assert_called_once_with(self.target, 42, "execute")


class UpdateRunStateMetadataFileTests(unittest.TestCase):
    """Hardening #3: update_run_state receives run.json as metadata_file (not phase metadata)."""

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
    def test_update_run_state_metadata_file_is_run_json_not_phase_metadata(
        self, mock_update, mock_summary, mock_build
    ):
        """metadata_file kwarg must be the run-level run.json path, and
        prompt_file must be the phase prompt (they are distinct paths)."""
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        self.assertTrue(mock_update.called)
        _, kwargs = mock_update.call_args

        # metadata_file must be the run-level run.json (rc.metadata_file)
        expected_metadata_file = str(self.rc.metadata_file)
        self.assertEqual(
            kwargs["metadata_file"],
            expected_metadata_file,
            "update_run_state must receive the run-level run.json as metadata_file",
        )

        # prompt_file must be the phase prompt (inside the phase directory)
        expected_phase_dir = self.run_dir / "plan"
        expected_prompt_file = str(expected_phase_dir / "prompt.md")
        self.assertEqual(
            kwargs["prompt_file"],
            expected_prompt_file,
            "update_run_state must receive the phase prompt.md as prompt_file",
        )

        # They must be distinct paths
        self.assertNotEqual(
            kwargs["metadata_file"],
            kwargs["prompt_file"],
            "metadata_file and prompt_file must be distinct paths",
        )


# ---------------------------------------------------------------------------
# Tests for run_issue orchestrator (Task 3)
# ---------------------------------------------------------------------------

def _make_run_issue_patches(
    *,
    resolution_text="Title\nbody",
    resolve_skills_return=None,
    context_pack_file=".agentrail/context/packs/p.json",
    context_pack_summary="SUM",
    context_snippets="SNIP",
    context_retrieval=None,
    render_state_summary="STATE",
    ralph_path_return=None,
    run_issue_phase_side_effect=None,
    gh_returncode=1,
    gh_stdout="",
):
    """Return a dict of patch targets → mock or return values for run_issue tests."""
    if resolve_skills_return is None:
        resolve_skills_return = {
            "resolved": [], "autoSkills": True, "maxAutoSkills": 4,
            "unavailable": [], "registryPath": "", "targetDir": "/tmp",
        }
    if context_retrieval is None:
        context_retrieval = {}
    if ralph_path_return is None:
        ralph_path_return = Path("/ralph")
    return {
        "resolution_text": resolution_text,
        "resolve_skills_return": resolve_skills_return,
        "context_pack_file": context_pack_file,
        "context_pack_summary": context_pack_summary,
        "context_snippets": context_snippets,
        "context_retrieval": context_retrieval,
        "render_state_summary": render_state_summary,
        "ralph_path_return": ralph_path_return,
        "run_issue_phase_side_effect": run_issue_phase_side_effect,
        "gh_returncode": gh_returncode,
        "gh_stdout": gh_stdout,
    }


class RunIssueHappyPathTests(unittest.TestCase):
    """Happy path: plan + execute both succeed."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _run_with_patches(self, cfg=None):
        if cfg is None:
            cfg = _make_run_issue_patches()

        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append({"phase": phase, "plan_output": plan_output})
            if phase == "plan":
                return (0, "PLAN OUT")
            return (0, "")

        side_effect = cfg.get("run_issue_phase_side_effect") or _phase_stub

        import subprocess as _sp
        gh_mock = MagicMock()
        gh_mock.returncode = cfg["gh_returncode"]
        gh_mock.stdout = cfg["gh_stdout"]

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text",
                   return_value=cfg["resolution_text"]), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   return_value=cfg["resolve_skills_return"]), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack",
                   return_value=cfg["context_pack_file"]), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary",
                   return_value=cfg["context_pack_summary"]), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets",
                   return_value=cfg["context_snippets"]), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata",
                   return_value=cfg["context_retrieval"]), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary",
                   return_value=cfg["render_state_summary"]), \
             patch("agentrail.run.pipeline.prompts.common_header",
                   return_value="HEADER"), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution",
                   return_value="SKILLS"), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt",
                   return_value="BASE PROMPT"), \
             patch("agentrail.run.pipeline._ralph_executor_path",
                   return_value=cfg["ralph_path_return"]), \
             patch("agentrail.run.pipeline.run_issue_phase",
                   side_effect=side_effect) as mock_phase, \
             patch("agentrail.run.pipeline.state_mod.update_run_state") as mock_update_state, \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts") as mock_update_meta, \
             patch("agentrail.run.pipeline.subprocess.run",
                   return_value=gh_mock):
            result = run_issue(
                self.target, 7,
                agent="claude",
                command="claude -p",
                repo_dir=self.repo,
            )
            return result, phase_calls, mock_phase, mock_update_state, mock_update_meta

    def test_happy_path_returns_0(self):
        result, _, _, _, _ = self._run_with_patches()
        self.assertEqual(result, 0)

    def test_happy_path_creates_run_dir(self):
        self._run_with_patches()
        runs_dir = self.target / ".agentrail" / "runs"
        run_dirs = list(runs_dir.iterdir())
        self.assertEqual(len(run_dirs), 1)

    def test_happy_path_creates_artifacts(self):
        self._run_with_patches()
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        self.assertTrue((run_dir / "prompt.md").is_file())
        self.assertTrue((run_dir / "resolved-skills.json").is_file())
        self.assertTrue((run_dir / "run.json").is_file())

    def test_happy_path_run_json_content(self):
        self._run_with_patches()
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        run_json = _read_json(run_dir / "run.json")
        self.assertEqual(run_json["targetIssue"], 7)
        self.assertEqual(run_json["agent"], "claude")
        self.assertEqual(run_json["contextPackFile"], ".agentrail/context/packs/p.json")

    def test_happy_path_run_issue_phase_called_plan_then_execute(self):
        _, phase_calls, _, _, _ = self._run_with_patches()
        self.assertEqual(len(phase_calls), 2)
        self.assertEqual(phase_calls[0]["phase"], "plan")
        self.assertEqual(phase_calls[1]["phase"], "execute")

    def test_happy_path_update_run_state_finish_called(self):
        _, _, _, mock_update_state, _ = self._run_with_patches()
        self.assertTrue(mock_update_state.called)
        args, kwargs = mock_update_state.call_args
        self.assertEqual(args[1], "finish")


class RunIssueReviewFixTests(unittest.TestCase):
    """review-fix label: plan phase skipped, only execute called."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_review_fix_skips_plan_calls_only_execute(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            return (0, "")

        gh_mock = MagicMock()
        gh_mock.returncode = 0
        gh_mock.stdout = "review-fix,bug"

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 0)
        self.assertNotIn("plan", phase_calls)
        self.assertIn("execute", phase_calls)


class RunIssueResumeTests(unittest.TestCase):
    """AGENTRAIL_RESUME=1: prior completed plan is reused, plan phase skipped."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_resume_skips_plan_uses_prior_output(self):
        runs_dir = self.target / ".agentrail" / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Pre-create a prior run dir with completed plan
        prior_dir = runs_dir / "20200101-000000-issue-7-claude-1"
        (prior_dir / "plan").mkdir(parents=True)
        (prior_dir / "plan" / "status.json").write_text(json.dumps({"status": "completed"}))
        (prior_dir / "plan" / "output.md").write_text("PRIOR PLAN")

        phase_calls = []
        captured_plan_outputs = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            captured_plan_outputs.append(plan_output)
            return (0, plan_output)

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch.dict(os.environ, {"AGENTRAIL_RESUME": "1"}, clear=False), \
             patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(
                self.target, 7,
                agent="claude",
                command="c",
                repo_dir=self.repo,
                log_dir=runs_dir,
            )

        self.assertEqual(result, 0)
        self.assertNotIn("plan", phase_calls)
        self.assertIn("execute", phase_calls)
        # execute call received the prior plan output
        execute_idx = phase_calls.index("execute")
        self.assertEqual(captured_plan_outputs[execute_idx], "PRIOR PLAN")


class RunIssueSkillsFailureDegradeTests(unittest.TestCase):
    """Skills failure: run_issue degrades gracefully, empty resolved list used."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_skills_resolution_error_degrades(self):
        from agentrail.run.skills import SkillResolutionError

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            return (0, "PLAN OUT") if phase == "plan" else (0, "")

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   side_effect=SkillResolutionError("no registry")), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
             patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 0)
        # resolved-skills.json must have empty resolved list
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        skills_data = _read_json(run_dir / "resolved-skills.json")
        self.assertEqual(skills_data["resolved"], [])


class RunIssueBadMaxAttemptsTests(unittest.TestCase):
    """AGENTRAIL_MAX_EXECUTION_ATTEMPTS=0 returns exit code 2."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_zero_max_attempts_returns_2(self):
        with patch.dict(os.environ, {"AGENTRAIL_MAX_EXECUTION_ATTEMPTS": "0"}, clear=False), \
             patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
             patch("agentrail.run.pipeline.skills.resolve_skills",
                   return_value={"resolved": [], "autoSkills": True}), \
             patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None), \
             patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value=""), \
             patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
             patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
             patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
             patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
             patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 2)


class RunIssuePlanFailureShortCircuitsTests(unittest.TestCase):
    """Plan failure: execute not called, final state has exit_status 1."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_plan_failure_short_circuits_execute(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            if phase == "plan":
                return (1, "")
            return (0, "")

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state") as mock_update_state, \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 1)
        self.assertNotIn("execute", phase_calls)
        # update_run_state called with finish and exit_status=1
        args, kwargs = mock_update_state.call_args
        self.assertEqual(args[1], "finish")
        self.assertEqual(kwargs["exit_status"], 1)


# ---------------------------------------------------------------------------
# New tests from code-review fixes
# ---------------------------------------------------------------------------

class RunIssueRalphNoneTests(unittest.TestCase):
    """ralph_path=None blocks only the legacy execute branch (AGENTRAIL_NATIVE_EXECUTE=0);
    the native default proceeds without ralph-loop."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, mock_phase):
        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=None), \
             patch("agentrail.run.pipeline.run_issue_phase", mock_phase), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            return run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

    def test_legacy_ralph_none_returns_1_without_raising(self):
        mock_phase = MagicMock()
        with patch.dict(os.environ, {"AGENTRAIL_NATIVE_EXECUTE": "0"}):
            result = self._run(mock_phase)

        self.assertEqual(result, 1)
        mock_phase.assert_not_called()

    def test_native_ralph_none_proceeds(self):
        """Native default: missing ralph-loop must NOT block; phases still run."""
        mock_phase = MagicMock(return_value=(0, ""))
        env = {k: v for k, v in os.environ.items() if k != "AGENTRAIL_NATIVE_EXECUTE"}
        with patch.dict(os.environ, env, clear=True):
            result = self._run(mock_phase)

        self.assertEqual(result, 0)
        self.assertTrue(mock_phase.called)


class RunIssueFinishPhaseOnPlanFailureTests(unittest.TestCase):
    """Fix 2: finish event must report phase='plan' when plan fails and execute is skipped."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_finish_phase_is_plan_when_plan_fails(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            if phase == "plan":
                return (1, "")
            return (0, "")

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state") as mock_update_state, \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 1)
        self.assertNotIn("execute", phase_calls)
        # finish event must carry phase="plan" and exit_status=1
        args, kwargs = mock_update_state.call_args
        self.assertEqual(args[1], "finish")
        self.assertEqual(kwargs["phase"], "plan")
        self.assertEqual(kwargs["exit_status"], 1)


class RunIssuePlanOutputThreadingTests(unittest.TestCase):
    """Fix 2 (happy path): execute call receives the plan_output returned by plan phase."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_execute_receives_plan_output(self):
        captured = {}

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "plan":
                return (0, "PLAN OUT")
            captured["execute_plan_output"] = plan_output
            return (0, "")

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(captured.get("execute_plan_output"), "PLAN OUT")


class RunIssueResumeNewestTests(unittest.TestCase):
    """Fix 3: with AGENTRAIL_RESUME=1 and two prior runs, the NEWEST plan is used."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_resume_picks_newest_prior_plan(self):
        runs_dir = self.target / ".agentrail" / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Older run
        older_dir = runs_dir / "20200101-000000-issue-7-claude-1"
        (older_dir / "plan").mkdir(parents=True)
        (older_dir / "plan" / "status.json").write_text(json.dumps({"status": "completed"}))
        (older_dir / "plan" / "output.md").write_text("OLD")

        # Newer run
        newer_dir = runs_dir / "20200202-000000-issue-7-claude-2"
        (newer_dir / "plan").mkdir(parents=True)
        (newer_dir / "plan" / "status.json").write_text(json.dumps({"status": "completed"}))
        (newer_dir / "plan" / "output.md").write_text("NEW")

        captured = {}

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute":
                captured["execute_plan_output"] = plan_output
            return (0, plan_output)

        gh_mock = MagicMock()
        gh_mock.returncode = 1
        gh_mock.stdout = ""

        with patch.dict(os.environ, {"AGENTRAIL_RESUME": "1"}, clear=False), \
             patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
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
             patch("agentrail.run.pipeline._ralph_executor_path", return_value=Path("/r")), \
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(
                self.target, 7,
                agent="claude",
                command="c",
                repo_dir=self.repo,
                log_dir=runs_dir,
            )

        self.assertEqual(result, 0)
        self.assertEqual(captured.get("execute_plan_output"), "NEW")


if __name__ == "__main__":
    unittest.main()
