"""Tests for agentrail/run/pipeline.py — run_issue_phase.

Uses unittest + unittest.mock. All external I/O is patched at the
agentrail.run.pipeline.* import names. A minimal .agentrail/state.json
is written so that update_run_state has a real file to operate on.
"""
from __future__ import annotations

import io
import json
import subprocess
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
    """Create a minimal .agentrail/state.json so update_run_state works.

    The Objective Gate (ADR 0007 / #769) drives "done" and the verification
    spine (ADR 0008) is ON BY DEFAULT (MVP): a run reaches GREEN only on a
    genuine red→green trail. We declare a sentinel-file ``verify`` check that is
    RED at the baseline and turned GREEN by the execute phase (the ``run_issue``
    fixtures below flip the sentinel in their execute stub). Helper
    ``_sentinel(target)`` returns the sentinel path so stubs can create it.

    Tests that exercise the no-verify or always-pass paths override the config
    explicitly.
    """
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    state_path = agentrail_dir / "state.json"
    state_path.write_text(json.dumps({"workflow": {}}))
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {_sentinel(target)}"})
    )
    return target


def _sentinel(target: Path) -> Path:
    """Path to the per-target red→green sentinel the execute stub creates."""
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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

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
    def test_execute_native_bash_stdin(self, mock_summary, mock_build):
        """Execute runs natively: bash -lc <agent_command> with the phase prompt
        on stdin, mirroring plan."""
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)
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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

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
        self.target = target
        self.run_dir = run_dir

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack")
    def test_plan_phase_reuses_run_context_pack_file(self, mock_build, mock_summary):
        """When run_context_pack_file is set, plan phase reuses it without calling build."""
        rc = _make_rc(self.target, self.run_dir,
                      run_context_pack_file="ctx/pack.json")
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(rc, "plan", 1)

        mock_build.assert_not_called()

    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="new_pack.json")
    def test_no_run_context_pack_file_calls_build(self, mock_build, mock_summary):
        """When run_context_pack_file is None, build_issue_context_pack is called."""
        rc = _make_rc(self.target, self.run_dir, run_context_pack_file=None)
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(rc, "plan", 1)

        mock_build.assert_called_once_with(self.target, 42, "plan")


# ---------------------------------------------------------------------------
# Hardening tests: three additional assertions for run_issue_phase
# ---------------------------------------------------------------------------

class ExecuteStdinHardeningTests(unittest.TestCase):
    """Both PLAN and EXECUTE now run natively and pass the phase prompt on stdin."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_execute_passes_stdin_text(self, mock_summary, mock_build):
        """Native execute phase passes the phase prompt on stdin (mirrors plan)."""
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1, plan_output="approved plan")

        self.assertEqual(len(stub.calls), 1)
        call_info = stub.calls[0]
        self.assertIsNotNone(
            call_info.get("stdin_text"),
            "native execute phase must pass the phase prompt on stdin",
        )
        self.assertEqual(call_info["argv"][:2], ["bash", "-lc"])

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    def test_plan_and_execute_both_pass_stdin_text(self, mock_summary, mock_build):
        """Both plan and execute pass a non-None stdin_text under the native path."""
        # Plan phase
        plan_stub = _stub_run_with_timeout(0, "plan output")
        with patch("agentrail.run.pipeline.run_with_timeout", plan_stub):
            run_issue_phase(self.rc, "plan", 1)
        self.assertIsNotNone(
            plan_stub.calls[0].get("stdin_text"),
            "plan phase must pass a non-None stdin_text",
        )

        # Execute phase
        exec_stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", exec_stub):
            run_issue_phase(self.rc, "execute", 1, plan_output="plan output")
        self.assertIsNotNone(
            exec_stub.calls[0].get("stdin_text"),
            "native execute phase must pass a non-None stdin_text",
        )


class ExecuteReusesOnDiskContextPackTests(unittest.TestCase):
    """Hardening #2: EXECUTE phase reuses an on-disk run-level context pack file."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        self.target = target
        self.run_dir = run_dir

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

        rc = _make_rc(self.target, self.run_dir,
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
        rc = _make_rc(self.target, self.run_dir,
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
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

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
    return {
        "resolution_text": resolution_text,
        "resolve_skills_return": resolve_skills_return,
        "context_pack_file": context_pack_file,
        "context_pack_summary": context_pack_summary,
        "context_snippets": context_snippets,
        "context_retrieval": context_retrieval,
        "render_state_summary": render_state_summary,
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
            # The Implementer (execute) flips the sentinel red→green so the
            # spine-on default reaches a GREEN gate (test-author authors the
            # failing test; only execute makes it pass).
            if phase == "execute":
                _sentinel(self.target).write_text("x")
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

    def test_happy_path_run_issue_phase_called_test_author_then_execute(self):
        """MVP: the spine-on default runs test-author → execute, with NO plan."""
        _, phase_calls, _, _, _ = self._run_with_patches()
        phases = [c["phase"] for c in phase_calls]
        self.assertEqual(phases, ["test-author", "execute"])
        self.assertNotIn("plan", phases)

    def test_happy_path_update_run_state_finish_called(self):
        _, _, _, mock_update_state, _ = self._run_with_patches()
        self.assertTrue(mock_update_state.called)
        args, kwargs = mock_update_state.call_args
        self.assertEqual(args[1], "finish")


class RunIssueNoPlanPhaseTests(unittest.TestCase):
    """MVP: the plan phase is GONE from the default flow regardless of labels.

    (Previously a ``review-fix`` label skipped plan; now there is no plan phase
    to skip at all — the flow is test-author → execute either way.)
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_no_plan_phase_runs(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            if phase == "execute":
                _sentinel(self.target).write_text("x")
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 0)
        self.assertNotIn("plan", phase_calls)
        self.assertEqual(phase_calls, ["test-author", "execute"])


class RunIssueResumeTests(unittest.TestCase):
    """MVP: with the plan phase gone there is no prior-plan to resume.

    A prior completed ``plan`` artifact on disk is simply ignored — the run
    proceeds with the spine flow (test-author → execute) and never reads it.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_resume_ignores_prior_plan_and_runs_spine(self):
        runs_dir = self.target / ".agentrail" / "runs"
        runs_dir.mkdir(parents=True, exist_ok=True)

        # Pre-create a prior run dir with a completed plan — it must be ignored.
        prior_dir = runs_dir / "20200101-000000-issue-7-claude-1"
        (prior_dir / "plan").mkdir(parents=True)
        (prior_dir / "plan" / "status.json").write_text(json.dumps({"status": "completed"}))
        (prior_dir / "plan" / "output.md").write_text("PRIOR PLAN")

        phase_calls = []
        captured_plan_outputs = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            captured_plan_outputs.append(plan_output)
            if phase == "execute":
                _sentinel(self.target).write_text("x")
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
        self.assertEqual(phase_calls, ["test-author", "execute"])
        # The prior plan output is never threaded in (plan is gone).
        self.assertNotIn("PRIOR PLAN", captured_plan_outputs)


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
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            return (0, "")

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


class RunIssueFirstPhaseFailureShortCircuitsTests(unittest.TestCase):
    """First-phase (test-author) failure: execute not called, exit_status 1.

    (Replaces the old plan-failure short-circuit: the test-author phase is now
    the first phase, and a failure there must still short-circuit execute.)
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_test_author_failure_short_circuits_execute(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            if phase == "test-author":
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state") as mock_update_state, \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 1)
        self.assertNotIn("execute", phase_calls)
        self.assertEqual(phase_calls, ["test-author"])
        # update_run_state called with finish and exit_status=1
        args, kwargs = mock_update_state.call_args
        self.assertEqual(args[1], "finish")
        self.assertEqual(kwargs["exit_status"], 1)


# ---------------------------------------------------------------------------
# New tests from code-review fixes
# ---------------------------------------------------------------------------

class RunIssueNoRalphDependencyTests(unittest.TestCase):
    """run_issue no longer depends on ralph-loop: it proceeds natively and runs
    its phases without any executor-path lookup."""

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
             patch("agentrail.run.pipeline.run_issue_phase", mock_phase), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            return run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

    def test_proceeds_and_runs_phases(self):
        """Native default: no ralph-loop required; the spine phases still run to
        completion and reach a GREEN gate on a genuine red→green trail."""
        def _phase(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            return (0, "")

        mock_phase = MagicMock(side_effect=_phase)
        result = self._run(mock_phase)

        self.assertEqual(result, 0)
        self.assertTrue(mock_phase.called)


class RunIssueFinishPhaseOnFirstPhaseFailureTests(unittest.TestCase):
    """Finish event must report phase='test-author' when the first (test-author)
    phase fails and execute is skipped (was plan in the legacy flow)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_finish_phase_is_test_author_when_test_author_fails(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            if phase == "test-author":
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state") as mock_update_state, \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(result, 1)
        self.assertNotIn("execute", phase_calls)
        # finish event must carry phase="test-author" and exit_status=1
        args, kwargs = mock_update_state.call_args
        self.assertEqual(args[1], "finish")
        self.assertEqual(kwargs["phase"], "test-author")
        self.assertEqual(kwargs["exit_status"], 1)


class RunIssueNoPlanOutputThreadingTests(unittest.TestCase):
    """MVP: with the plan phase gone, the execute phase receives an EMPTY
    plan_output (there is no plan to thread through)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_execute_receives_empty_plan_output(self):
        captured = {}

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute":
                _sentinel(self.target).write_text("x")
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)

        self.assertEqual(captured.get("execute_plan_output"), "")


class RunIssueResumeIgnoresPriorPlansTests(unittest.TestCase):
    """MVP: with AGENTRAIL_RESUME=1 and prior runs on disk, no prior plan is
    reused (the plan phase is gone). The execute phase gets an empty plan_output
    regardless of any prior plan artifacts."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_resume_ignores_prior_plans(self):
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
                _sentinel(self.target).write_text("x")
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
        self.assertEqual(captured.get("execute_plan_output"), "")


# ---------------------------------------------------------------------------
# Cost capture tests (issue #460)
# ---------------------------------------------------------------------------

class CostCaptureNonFatalTests(unittest.TestCase):
    """AC2: any exception in capture/cost/push is non-fatal; run exit code unchanged."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.capture_usage", side_effect=RuntimeError("transcript error"))
    def test_capture_usage_raises_does_not_change_exit_0(self, mock_capture, mock_summary, mock_build):
        """AC2: capture_usage raising must not affect the phase exit code."""
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, _ = run_issue_phase(self.rc, "plan", 1)
        self.assertEqual(exit_status, 0)
        mock_capture.assert_called_once()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.push_cost_event", side_effect=RuntimeError("network down"))
    @patch("agentrail.run.pipeline.cost_usd", return_value=0.05)
    @patch("agentrail.run.pipeline.capture_usage")
    def test_push_cost_event_raises_does_not_change_exit_0(
        self, mock_capture, mock_cost, mock_push, mock_summary, mock_build
    ):
        """AC2: push_cost_event raising must not affect the phase exit code."""
        from agentrail.run.usage_capture import Usage
        mock_capture.return_value = Usage(
            model="claude-sonnet-4-6", input_tokens=100, output_tokens=50, cache_tokens=0
        )
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, _ = run_issue_phase(self.rc, "execute", 1)
        self.assertEqual(exit_status, 0)
        mock_push.assert_called_once()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.capture_usage", side_effect=RuntimeError("oops"))
    def test_capture_raises_on_failed_phase_exit_still_nonzero(
        self, mock_capture, mock_summary, mock_build
    ):
        """AC2: non-fatal cost block must not mask a real phase failure (exit != 0)."""
        stub = _stub_run_with_timeout(1)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, _ = run_issue_phase(self.rc, "plan", 1)
        self.assertEqual(exit_status, 1)


class CostCaptureHappyPathTests(unittest.TestCase):
    """AC1 proxy: capture_usage, cost_usd, push_cost_event each called once per phase."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        target = _make_target(self._tmp.name)
        run_dir = Path(self._tmp.name) / "run"
        self.target = target
        self.run_dir = run_dir
        self.rc = _make_rc(target, run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.push_cost_event", return_value=True)
    @patch("agentrail.run.pipeline.cost_usd", return_value=0.042)
    @patch("agentrail.run.pipeline.capture_usage")
    def test_cost_functions_called_once_on_success(
        self, mock_capture, mock_cost, mock_push, mock_summary, mock_build
    ):
        """AC1 proxy: all three cost functions invoked once when usage is returned."""
        from agentrail.run.usage_capture import Usage
        fake_usage = Usage(
            model="claude-sonnet-4-6", input_tokens=1000, output_tokens=500, cache_tokens=100
        )
        mock_capture.return_value = fake_usage

        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, _ = run_issue_phase(self.rc, "plan", 1)

        self.assertEqual(exit_status, 0)
        mock_capture.assert_called_once_with(self.rc.agent, self.rc.target_dir, unittest.mock.ANY)
        mock_cost.assert_called_once_with(fake_usage)
        mock_push.assert_called_once_with(
            self.rc.target_dir, self.rc.run_id, "plan", fake_usage, 0.042
        )

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.push_cost_event", return_value=True)
    @patch("agentrail.run.pipeline.cost_usd", return_value=0.0)
    @patch("agentrail.run.pipeline.capture_usage", return_value=None)
    def test_cost_push_skipped_when_capture_returns_none(
        self, mock_capture, mock_cost, mock_push, mock_summary, mock_build
    ):
        """When capture_usage returns None (unknown agent), push is not called."""
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            exit_status, _ = run_issue_phase(self.rc, "plan", 1)

        self.assertEqual(exit_status, 0)
        mock_capture.assert_called_once()
        mock_cost.assert_not_called()
        mock_push.assert_not_called()

    @patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value=None)
    @patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="ctx summary")
    @patch("agentrail.run.pipeline.build_cost_record", side_effect=RuntimeError("boom"))
    @patch("agentrail.run.pipeline.push_cost_event", return_value=True)
    @patch("agentrail.run.pipeline.cost_usd", return_value=0.042)
    @patch("agentrail.run.pipeline.capture_usage")
    def test_ledger_write_failure_does_not_skip_cost_accounting(
        self, mock_capture, mock_cost, mock_push, mock_record, mock_summary, mock_build
    ):
        """Regression (#714): a ledger-write failure must NOT skip cumulative cost
        accounting — otherwise the budget guardrail is silently defeated."""
        from agentrail.run.usage_capture import Usage
        mock_capture.return_value = Usage(
            model="claude-sonnet-4-6", input_tokens=1000, output_tokens=500, cache_tokens=100
        )
        before = self.rc.cumulative_cost_usd
        stub = _stub_run_with_timeout(0)
        with patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "plan", 1)

        # cost was accounted despite build_cost_record/ledger blowing up
        self.assertAlmostEqual(self.rc.cumulative_cost_usd, before + 0.042)
        mock_push.assert_called_once()  # remote push still attempted


# ---------------------------------------------------------------------------
# Objective Gate wiring tests (issue #769, AC2): done is gate-driven
# ---------------------------------------------------------------------------

class RunIssueObjectiveGateWiringTests(unittest.TestCase):
    """run_issue runs the OBJECTIVE checks after execute, evaluates the gate, and
    its returned done-ness reflects ``gate_result.is_green`` — NOT the raw agent
    exit status (ADR 0007). These drive the full wiring through ``run_issue``
    with the agent phases stubbed green and a real ``verify`` config.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _write_verify(self, payload):
        cfg = self.target / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def _run(self, execute_side_effect=None):
        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute" and execute_side_effect is not None:
                execute_side_effect()
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, _read_json(run_dir / "run.json")

    def test_done_when_verify_passes_and_declared(self):
        """A declared verify on a genuine red→green trail → gate green → done.

        (Spine-on by default: the check is RED at the baseline and GREEN after
        the Implementer creates the sentinel, so it is not tautological.)"""
        sentinel = self.target / "impl_done"
        self._write_verify({"verify": f"test -f {sentinel}"})
        result, run_json = self._run(execute_side_effect=lambda: sentinel.write_text("x"))
        self.assertEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")
        self.assertTrue(run_json["objectiveGate"]["isGreen"])

    def test_not_done_when_verify_fails(self):
        """verify command fails → gate red → NOT done, even though the agent
        phases exited 0."""
        self._write_verify({"verify": "false"})
        result, run_json = self._run()
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")

    def test_not_done_when_no_verify_declared(self):
        """No verify configured → AcCoverage(0,0) → gate red ('no verification
        declared') → NOT done, regardless of a clean agent exit."""
        # Remove the default passing verify config so NO verification is declared.
        (self.target / ".agentrail" / "config.json").unlink()
        result, run_json = self._run()
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")
        self.assertIn(
            "acceptance-criteria not satisfied",
            run_json["objectiveGate"]["failedReasons"],
        )

    def test_gate_overrides_clean_agent_exit(self):
        """The done signal is the gate, not the agent's self-reported exit: a
        failing verify turns a clean (exit 0) agent run into not-done."""
        self._write_verify({"verify": "false"})
        result, _ = self._run()
        self.assertNotEqual(result, 0)

    def test_multiple_checks_one_failing_is_red(self):
        self._write_verify(
            {"verify": [{"name": "ok", "command": "true"},
                        {"name": "bad", "command": "false"}]}
        )
        result, run_json = self._run()
        self.assertNotEqual(result, 0)
        self.assertIn("bad", run_json["objectiveGate"]["failedReasons"])


class RunIssueRedGreenProofWiringTests(unittest.TestCase):
    """run_issue consults the Red-Green Proof recorder when ``redGreenProof`` is
    set (#772, ADR 0008): the Objective Gate refuses done unless the acceptance
    test was observed failing before implementation and passing after. A
    never-failed (tautological) test cannot reach done even when verify passes.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _write_config(self, payload):
        cfg = self.target / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def _run(self, execute_side_effect=None):
        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            # The Implementer is the EXECUTE phase only — the side effect that
            # makes the acceptance test pass must fire there, not in the distinct
            # test-author phase (which authors the failing test before any impl).
            if phase == "execute" and execute_side_effect is not None:
                execute_side_effect()
            return (0, "PLAN OUT") if phase == "plan" else (0, "")

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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, _read_json(run_dir / "run.json")

    def test_refuses_done_when_test_never_failed(self):
        """AC3: verify passes both before AND after implementation (never red →
        tautological). With the proof required, the gate refuses done."""
        self._write_config({"verify": "true", "redGreenProof": True})
        result, run_json = self._run()
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")
        self.assertTrue(
            any("red-green" in r.lower() for r in run_json["objectiveGate"]["failedReasons"])
        )

    def test_done_with_a_real_fail_then_pass_trail(self):
        """A genuine red→green trail reaches done: verify fails before the
        execute phase (no sentinel) and passes after (the stub creates it)."""
        sentinel = self.target / "impl_done"
        self._write_config(
            {"verify": f"test -f {sentinel}", "redGreenProof": True}
        )
        result, run_json = self._run(execute_side_effect=lambda: sentinel.write_text("x"))
        self.assertEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")

    def test_explicit_opt_out_keeps_minimal_behavior(self):
        """With the explicit ``redGreenProof: false`` opt-out, an always-passing
        verify is still done — the Red-Green requirement is bypassed (AC3). (The
        spine is ON by default now, so this requires the explicit opt-out.)"""
        self._write_config({"verify": "true", "redGreenProof": False})
        result, run_json = self._run()
        self.assertEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")


# ---------------------------------------------------------------------------
# Test-Author / Implementer role split ordering (issue #775, ADR 0008)
# ---------------------------------------------------------------------------

class RunIssueTestAuthorPhaseOrderingTests(unittest.TestCase):
    """When ``redGreenProof`` is set, a DISTINCT ``test-author`` phase runs
    STRICTLY BEFORE the execute phase (AC1, AC3). Without the opt-in flag, no
    test-author phase runs — the many existing single-execute fixtures stay
    green (behavior unchanged).
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _write_config(self, payload):
        cfg = self.target / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def _run(self):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            return (0, "PLAN OUT") if phase == "plan" else (0, "")

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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)
        return phase_calls

    def test_test_author_runs_strictly_before_execute(self):
        """AC1+AC3: with the spine on (default), a distinct test-author phase
        precedes execute."""
        self._write_config({"verify": "true", "redGreenProof": True})
        phase_calls = self._run()
        self.assertIn("test-author", phase_calls)
        self.assertIn("execute", phase_calls)
        self.assertLess(
            phase_calls.index("test-author"),
            phase_calls.index("execute"),
            "test-author must run before execute",
        )

    def test_ordering_is_test_author_then_execute(self):
        """MVP: the spine flow is test-author → execute (NO plan phase)."""
        self._write_config({"verify": "true", "redGreenProof": True})
        phase_calls = self._run()
        self.assertEqual(phase_calls, ["test-author", "execute"])

    def test_spine_on_by_default_runs_test_author(self):
        """AC2: with no special config (spine ON by default) a test-author phase
        runs as the first phase."""
        self._write_config({"verify": "true"})
        phase_calls = self._run()
        self.assertEqual(phase_calls, ["test-author", "execute"])

    def test_explicit_opt_out_skips_test_author(self):
        """AC3: ``redGreenProof: false`` restores the minimal flow — no
        test-author phase, just execute."""
        self._write_config({"verify": "true", "redGreenProof": False})
        phase_calls = self._run()
        self.assertNotIn("test-author", phase_calls)
        self.assertEqual(phase_calls, ["execute"])


class RunIssueAntiFalseGreenTrailTests(unittest.TestCase):
    """The gate reaches GREEN only on a genuine red→green trail, and a
    tautological acceptance test that never went red keeps the gate RED even
    when the final verify passes (anti-false-green, AC2/AC3).
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _write_config(self, payload):
        cfg = self.target / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def _run(self, execute_side_effect=None):
        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            # Only the Implementer (execute) phase may make the test pass; the
            # distinct test-author phase authors the failing test before any impl.
            if phase == "execute" and execute_side_effect is not None:
                execute_side_effect()
            return (0, "PLAN OUT") if phase == "plan" else (0, "")

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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, _read_json(run_dir / "run.json")

    def test_implementer_flips_red_to_green_reaches_done(self):
        """AC2: the acceptance test fails before execute and passes after the
        Implementer's change → valid fail→pass trail → gate green → done."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}", "redGreenProof": True})
        result, run_json = self._run(execute_side_effect=lambda: sentinel.write_text("x"))
        self.assertEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")

    def test_tautological_test_never_red_keeps_gate_red(self):
        """Anti-false-green: a test that passes BOTH before and after (never
        red) is tautological — the gate refuses done even though verify passes."""
        # ``true`` passes at the baseline AND after execute → never observed red.
        self._write_config({"verify": "true", "redGreenProof": True})
        result, run_json = self._run()
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")
        self.assertTrue(
            any("red-green" in r.lower() for r in run_json["objectiveGate"]["failedReasons"])
        )


# ---------------------------------------------------------------------------
# Independent Verifier wiring (issue #782, ADR 0008)
# ---------------------------------------------------------------------------

class RunIssueVerifierWiringTests(unittest.TestCase):
    """When a DIFFERENT-model verifier command is configured (phase_commands
    carries a distinct ``verify`` command) and the Red-Green Proof is on, the
    pipeline runs a ``verify`` phase after execute, parses the structured verdict
    from its output, and feeds it into the Objective Gate. A REJECT blocks done
    (AC3); an ACCEPT lets a genuine trail reach GREEN. Without a verifier command
    no verify phase runs (behavior unchanged).
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _write_config(self, payload):
        cfg = self.target / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def _run(self, *, phase_commands=None, verify_output="", execute_side_effect=None):
        phase_calls = []

        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            phase_calls.append(phase)
            if phase == "execute" and execute_side_effect is not None:
                execute_side_effect()
            # The verify phase writes its verdict to output.md — emulate the agent
            # by writing the configured verdict text there.
            if phase == "verify":
                out = rc.run_dir / "verify" / "output.md"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(verify_output)
            return (0, "PLAN OUT") if phase == "plan" else (0, "")

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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
             patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
            result = run_issue(
                self.target, 7, agent="claude", command="c", repo_dir=self.repo,
                phase_commands=phase_commands or {},
            )
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, _read_json(run_dir / "run.json"), phase_calls

    def test_verify_phase_runs_after_execute_with_distinct_command(self):
        """AC1: a distinct verifier command → a verify phase runs after execute."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}", "redGreenProof": True})
        _, _, phase_calls = self._run(
            phase_commands={"verify": "claude -p --model claude-sonnet-4-6"},
            verify_output='VERDICT: {"verdict": "accept", "reason": "ok"}',
            execute_side_effect=lambda: sentinel.write_text("x"),
        )
        self.assertIn("verify", phase_calls)
        self.assertLess(phase_calls.index("execute"), phase_calls.index("verify"))

    def test_verifier_rejection_blocks_done(self):
        """AC2+AC3: the verifier REJECTS a gamed test → gate RED → not done, even
        though the implementer's trail is genuine and verify passes."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}", "redGreenProof": True})
        result, run_json, _ = self._run(
            phase_commands={"verify": "claude -p --model claude-sonnet-4-6"},
            verify_output='VERDICT: {"verdict": "reject", "reason": "tautological test"}',
            execute_side_effect=lambda: sentinel.write_text("x"),
        )
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")
        self.assertTrue(
            any("verification" in r.lower()
                for r in run_json["objectiveGate"]["failedReasons"])
        )

    def test_verifier_acceptance_allows_genuine_trail_to_green(self):
        """A genuine red→green trail + an ACCEPT verdict reaches done."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}", "redGreenProof": True})
        result, run_json, _ = self._run(
            phase_commands={"verify": "claude -p --model claude-sonnet-4-6"},
            verify_output='VERDICT: {"verdict": "accept", "reason": "tests pin the AC"}',
            execute_side_effect=lambda: sentinel.write_text("x"),
        )
        self.assertEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")

    def test_unparseable_verifier_output_failcloses_to_reject(self):
        """A verifier that emits no verdict is fail-closed → done blocked."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}", "redGreenProof": True})
        result, run_json, _ = self._run(
            phase_commands={"verify": "claude -p --model claude-sonnet-4-6"},
            verify_output="the verifier crashed",
            execute_side_effect=lambda: sentinel.write_text("x"),
        )
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")

    def test_no_verify_phase_without_verifier_command(self):
        """No distinct verifier command (e.g. no different model available) →
        no verify phase runs; the red-green-only behavior is unchanged."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}", "redGreenProof": True})
        result, run_json, phase_calls = self._run(
            phase_commands={},  # no verifier command
            execute_side_effect=lambda: sentinel.write_text("x"),
        )
        self.assertNotIn("verify", phase_calls)
        self.assertEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")

    def test_no_verify_phase_when_explicitly_opted_out(self):
        """With the explicit ``redGreenProof: false`` opt-out, the verifier never
        runs even if a verifier command is present (the minimal flow has no
        role split). (Spine is ON by default, so this needs the opt-out.)"""
        self._write_config({"verify": "true", "redGreenProof": False})
        _, _, phase_calls = self._run(
            phase_commands={"verify": "claude -p --model claude-sonnet-4-6"},
        )
        self.assertNotIn("verify", phase_calls)

    def test_verify_phase_runs_by_default_with_distinct_command(self):
        """AC2: spine ON by default → a distinct verifier command runs a verify
        phase after execute even with no explicit redGreenProof flag."""
        sentinel = self.target / "impl_done"
        self._write_config({"verify": f"test -f {sentinel}"})
        _, _, phase_calls = self._run(
            phase_commands={"verify": "claude -p --model claude-sonnet-4-6"},
            verify_output='VERDICT: {"verdict": "accept", "reason": "ok"}',
            execute_side_effect=lambda: sentinel.write_text("x"),
        )
        self.assertIn("verify", phase_calls)


# ---------------------------------------------------------------------------
# Red-Green Proof trail waiver for test-free changes (issue #907)
# ---------------------------------------------------------------------------

class RunIssueDocsConfigTrailWaiverTests(unittest.TestCase):
    """The Red-Green Proof trail is WAIVED for a legitimately test-free change
    (docs/config only) so the gate stops false-redding it — without weakening
    anti-false-green: a change touching Python source still requires the trail.

    These run against a REAL git repo as the target so the pipeline's
    ``collect_changed_files`` sees an actual change set (the unit-level
    classification is covered in test_verify_gate_classification.py).
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()
        # Make the target a real git repo with a clean baseline. Ignore the run
        # artifacts the pipeline writes during the run so they don't pollute the
        # change set the gate classifies.
        (self.target / ".gitignore").write_text(".agentrail/runs/\n.agentrail/run/\n")
        self._git("init", "-b", "main")
        self._git("config", "user.email", "t@t.com")
        self._git("config", "user.name", "t")
        self._git("add", "-A")
        self._git("commit", "-m", "baseline")

    def tearDown(self):
        self._tmp.cleanup()

    def _git(self, *args):
        subprocess.run(["git", *args], cwd=self.target, check=True, capture_output=True)

    def _write_config(self, payload):
        cfg = self.target / ".agentrail" / "config.json"
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(json.dumps(payload))

    def _run(self, execute_side_effect=None):
        def _phase_stub(rc, phase, attempt, verifier_findings_file="", plan_output=""):
            if phase == "execute" and execute_side_effect is not None:
                execute_side_effect()
            return (0, "PLAN OUT") if phase == "plan" else (0, "")

        # NOTE: unlike the other RunIssue fixtures, this class does NOT patch
        # ``subprocess.run`` — the pipeline's #907 change-set classification
        # shells out to real git (against the real repo this class sets up), and
        # a global subprocess.run mock would clobber it. run_issue_phase is fully
        # stubbed, so no other real subprocess.run call happens in this path.
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
             patch("agentrail.run.pipeline.run_issue_phase", side_effect=_phase_stub), \
             patch("agentrail.run.pipeline.state_mod.update_run_state"), \
             patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"):
            result = run_issue(self.target, 7, agent="claude", command="c", repo_dir=self.repo)
        runs_dir = self.target / ".agentrail" / "runs"
        run_dir = next(runs_dir.iterdir())
        return result, _read_json(run_dir / "run.json")

    def test_docs_only_change_reaches_green_despite_tautological_verify(self):
        """AC1: a docs-only change whose verify always passes (no fail→pass
        trail possible) STILL reaches green — the trail is waived for test-free
        changes. Without the #907 fix this is red ("red-green proof trail
        invalid")."""
        self._write_config({"verify": "true", "redGreenProof": True})
        # The execute phase produces a docs-only change in the working tree.
        result, run_json = self._run(
            execute_side_effect=lambda: (self.target / "docs").mkdir(exist_ok=True)
            or (self.target / "docs" / "guide.md").write_text("# guide\n")
        )
        self.assertEqual(result, 0, run_json["objectiveGate"])
        self.assertEqual(run_json["objectiveGate"]["verdict"], "green")

    def test_source_change_without_trail_stays_red(self):
        """AC2: a change that touches Python source still REQUIRES the trail —
        an always-passing (tautological) verify keeps the gate red. The waiver
        must not weaken anti-false-green."""
        self._write_config({"verify": "true", "redGreenProof": True})
        result, run_json = self._run(
            execute_side_effect=lambda: (self.target / "pkg").mkdir(exist_ok=True)
            or (self.target / "pkg" / "feature.py").write_text("x = 1\n")
        )
        self.assertNotEqual(result, 0)
        self.assertEqual(run_json["objectiveGate"]["verdict"], "red")
        self.assertTrue(
            any("red-green" in r.lower() for r in run_json["objectiveGate"]["failedReasons"])
        )


if __name__ == "__main__":
    unittest.main()
