"""Unit tests for ``agentrail status`` CLI command (agentrail/cli/commands/status.py).

All external I/O is patched; filesystem is exercised via temporary directories.
No legacy subprocess is invoked.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.status import run_status, render_status


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_target(tmp: Path) -> Path:
    target = tmp / "target"
    target.mkdir()
    return target


def _write_state(target: Path, state: dict) -> None:
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")


def _capture(fn, *args, **kwargs):
    """Capture stdout from fn(*args, **kwargs), return (stdout_str, return_code)."""
    buf = StringIO()
    with patch("sys.stdout", buf):
        rc = fn(*args, **kwargs)
    return buf.getvalue(), rc


# ---------------------------------------------------------------------------
# Tests: missing state
# ---------------------------------------------------------------------------

class TestMissingState(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_missing_state_output(self):
        out, rc = _capture(run_status, ["--target", str(self.target)])
        self.assertEqual(rc, 0)
        self.assertIn(f"AgentRail status: {self.target}", out)
        self.assertIn("install status: missing-state", out)
        # state_recommendation text
        self.assertIn("AgentRail state was not found", out)
        # blank line between "install status" and recommendation
        self.assertIn("\n\n", out)

    def test_missing_state_no_legacy_subprocess(self):
        """Verify legacy subprocess is NOT called."""
        with patch("subprocess.run") as mock_run:
            out, rc = _capture(run_status, ["--target", str(self.target)])
            for call in mock_run.call_args_list:
                cmd = call[0][0] if call[0] else call[1].get("args", [])
                if isinstance(cmd, (list, tuple)):
                    self.assertFalse(
                        any("agentrail-legacy" in str(c) for c in cmd),
                        f"Legacy subprocess was called: {cmd}",
                    )


# ---------------------------------------------------------------------------
# Tests: state-present
# ---------------------------------------------------------------------------

class TestStatePresent(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()

        self.state = {
            "agentrailVersion": "2.5.0",
            "installedAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-06-01T00:00:00.000Z",
            "legacyAdopted": False,
            "workflow": {
                "phase": "implementation",
                "activePhase": "coding",
                "activeIssue": 7,
                "activePullRequest": None,
                "activePrd": None,
                "activeMilestone": None,
                "activeRun": {
                    "targetType": "issue",
                    "targetIssue": 7,
                    "agent": "claude",
                    "status": "running",
                    "maxExecutionAttempts": 3,
                    "executionAttempt": 1,
                    "failedVerificationAttempts": 0,
                },
                "goals": [
                    {
                        "id": "issue-7",
                        "status": "active",
                        "activeIssue": 7,
                        "summary": "Fix the bug",
                    }
                ],
                "completedRuns": [],
                "worktrees": [],
                "lastCompletedStep": None,
                "nextSuggestedAction": "Continue issue #7",
            },
        }
        _write_state(self.target, self.state)

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _run(self, env_key=None):
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        if env_key:
            env["AGENTRAIL_API_KEY"] = env_key
        with patch.dict(os.environ, env, clear=True):
            return _capture(run_status, ["--target", str(self.target)])

    def test_state_present_header(self):
        out, rc = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("install status: state-present", out)
        self.assertIn(f"AgentRail status: {self.target}", out)

    def test_version_and_timestamps(self):
        out, _ = self._run()
        self.assertIn("agentrail version: 2.5.0", out)
        self.assertIn("installed at: 2025-01-01T00:00:00.000Z", out)
        self.assertIn("updated at: 2025-06-01T00:00:00.000Z", out)

    def test_legacy_adopted_lowercase_false(self):
        """Legacy JS Boolean() prints lowercase 'false'; must not be 'False'."""
        out, _ = self._run()
        self.assertIn("legacy adopted: false", out)
        self.assertNotIn("legacy adopted: False", out)
        self.assertNotIn("legacy adopted: True", out)

    def test_legacy_adopted_lowercase_true(self):
        self.state["legacyAdopted"] = True
        _write_state(self.target, self.state)
        out, _ = self._run()
        self.assertIn("legacy adopted: true", out)
        self.assertNotIn("legacy adopted: True", out)

    def test_active_issue(self):
        out, _ = self._run()
        self.assertIn("  active issue: 7", out)

    def test_active_run_label(self):
        out, _ = self._run()
        self.assertIn("  active run: issue #7 via claude (running)", out)

    def test_active_goals(self):
        out, _ = self._run()
        self.assertIn("  active goals:", out)
        self.assertIn("issue-7 active issue #7: Fix the bug", out)

    def test_attempt_summary(self):
        out, _ = self._run()
        self.assertIn("  active run attempts: 1/3; failed verify attempts: 0", out)

    def test_dashboard_line_present(self):
        out, _ = self._run()
        self.assertIn("dashboard:", out)

    def test_last_completed_step_none(self):
        out, _ = self._run()
        self.assertIn("  last completed step: none", out)

    def test_next_action(self):
        out, _ = self._run()
        self.assertIn("  next action: Continue issue #7", out)

    def test_no_legacy_subprocess(self):
        with patch("subprocess.run") as mock_run:
            _capture(run_status, ["--target", str(self.target)])
            for call in mock_run.call_args_list:
                cmd = call[0][0] if call[0] else call[1].get("args", [])
                if isinstance(cmd, (list, tuple)):
                    self.assertFalse(
                        any("agentrail-legacy" in str(c) for c in cmd),
                        f"Legacy subprocess was called: {cmd}",
                    )


# ---------------------------------------------------------------------------
# Tests: corrupt state
# ---------------------------------------------------------------------------

class TestCorruptState(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()
        agentrail_dir = self.target / ".agentrail"
        agentrail_dir.mkdir()
        (agentrail_dir / "state.json").write_text("NOT VALID JSON {{{{", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_corrupt_state_output(self):
        out, rc = _capture(run_status, ["--target", str(self.target)])
        self.assertEqual(rc, 1)
        self.assertIn("install status: corrupt-state", out)
        self.assertIn("state error:", out)

    def test_corrupt_state_no_legacy_subprocess(self):
        with patch("subprocess.run") as mock_run:
            _capture(run_status, ["--target", str(self.target)])
            for call in mock_run.call_args_list:
                cmd = call[0][0] if call[0] else call[1].get("args", [])
                if isinstance(cmd, (list, tuple)):
                    self.assertFalse(
                        any("agentrail-legacy" in str(c) for c in cmd),
                        f"Legacy subprocess was called: {cmd}",
                    )


# ---------------------------------------------------------------------------
# Tests: dashboard line
# ---------------------------------------------------------------------------

class TestDashboardLine(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "2025-01-01T00:00:00.000Z",
            "updatedAt": "2025-01-01T00:00:00.000Z",
            "legacyAdopted": False,
            "workflow": {"phase": "idle"},
        })

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_dashboard_with_api_key(self):
        with patch.dict(os.environ, {"AGENTRAIL_API_KEY": "secret-key"}):
            out, rc = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("dashboard:", out)
        self.assertIn("  connected (AGENTRAIL_API_KEY)", out)

    def test_dashboard_without_api_key(self):
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, rc = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("dashboard:", out)
        self.assertIn("  not configured (local-only mode)", out)


# ---------------------------------------------------------------------------
# Tests: completed runs
# ---------------------------------------------------------------------------

class TestCompletedRuns(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_completed_runs_last_5(self):
        # Build 7 completed runs; only last 5 should appear.
        runs = [
            {"targetType": "issue", "targetIssue": i, "agent": "claude", "status": "completed"}
            for i in range(1, 8)
        ]
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {
                "phase": "idle",
                "completedRuns": runs,
            },
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, rc = _capture(run_status, ["--target", str(self.target)])
        self.assertEqual(rc, 0)
        # Issues 3-7 should appear; issues 1-2 should NOT
        self.assertIn("issue #7", out)
        self.assertIn("issue #3", out)
        self.assertNotIn("issue #1 via", out)
        self.assertNotIn("issue #2 via", out)

    def test_blocked_reason_shown(self):
        runs = [
            {
                "targetType": "issue",
                "targetIssue": 5,
                "agent": "codex",
                "status": "failed",
                "blockedReason": "tests failed",
            }
        ]
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {"phase": "idle", "completedRuns": runs},
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, _ = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("  completed run blocked reason: tests failed", out)


# ---------------------------------------------------------------------------
# Tests: worktrees
# ---------------------------------------------------------------------------

class TestWorktrees(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_worktrees_shown(self):
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {
                "phase": "idle",
                "worktrees": [
                    {"issue": 7, "pr": 42, "status": "running", "path": ".worktrees/issue-7"},
                ],
            },
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, _ = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("  worktrees:", out)
        self.assertIn("issue #7 PR #42: running .worktrees/issue-7", out)

    def test_worktrees_removed_at(self):
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {
                "phase": "idle",
                "worktrees": [
                    {
                        "issue": 3,
                        "status": "merged",
                        "path": ".worktrees/issue-3",
                        "removedAt": "2025-05-01T00:00:00.000Z",
                    },
                ],
            },
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, _ = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("removed 2025-05-01T00:00:00.000Z", out)

    def test_worktrees_last_5_only(self):
        wts = [{"issue": i, "status": "completed", "path": f".worktrees/issue-{i}"} for i in range(1, 9)]
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {"phase": "idle", "worktrees": wts},
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, _ = _capture(run_status, ["--target", str(self.target)])
        # Last 5: issues 4-8 should appear; 1-3 should NOT
        self.assertIn("issue #8", out)
        self.assertIn("issue #4", out)
        self.assertNotIn("issue #1:", out)
        self.assertNotIn("issue #3:", out)


# ---------------------------------------------------------------------------
# Tests: telemetry line
# ---------------------------------------------------------------------------

class TestTelemetryLine(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {"phase": "idle"},
        })

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_telemetry_line_appended_when_outbox_exists(self):
        """When count_outbox/load_last_flush work, telemetry line is printed."""
        with patch("agentrail.afk.telemetry.count_outbox", return_value=3) as mock_count, \
             patch("agentrail.afk.telemetry.load_last_flush", return_value="2025-06-01T00:00:00.000Z"):
            env = os.environ.copy()
            env.pop("AGENTRAIL_API_KEY", None)
            with patch.dict(os.environ, env, clear=True):
                out, _ = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("telemetry: 3 events queued, last flush 2025-06-01T00:00:00.000Z", out)

    def test_telemetry_line_never_missing_on_exception(self):
        """If telemetry import fails, the command still succeeds without crashing."""
        with patch.dict("sys.modules", {"agentrail.afk.telemetry": None}):
            env = os.environ.copy()
            env.pop("AGENTRAIL_API_KEY", None)
            with patch.dict(os.environ, env, clear=True):
                # should not raise
                out, rc = _capture(run_status, ["--target", str(self.target)])
        self.assertEqual(rc, 0)
        self.assertIn("install status: state-present", out)


# ---------------------------------------------------------------------------
# Tests: unknown option / arg parsing
# ---------------------------------------------------------------------------

class TestArgParsing(unittest.TestCase):

    def test_unknown_option_exits_2(self):
        buf = StringIO()
        err_buf = StringIO()
        with patch("sys.stderr", err_buf):
            with self.assertRaises(SystemExit) as ctx:
                from agentrail.cli.commands.status import _parse_target
                _parse_target(["--foo"])
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("Unknown option: --foo", err_buf.getvalue())

    def test_help_exits_0(self):
        with self.assertRaises(SystemExit) as ctx:
            from agentrail.cli.commands.status import _parse_target
            _parse_target(["-h"])
        self.assertEqual(ctx.exception.code, 0)


# ---------------------------------------------------------------------------
# Tests: null-coalesce behaviour (active phase = None → "none")
# ---------------------------------------------------------------------------

class TestNullCoalesceFields(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.target = Path(self._tmp) / "target"
        self.target.mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_null_fields_show_none(self):
        """activePhase=null, activeIssue=null → "none" (JS ?? operator)."""
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {
                "phase": "idle",
                "activePhase": None,
                "activeIssue": None,
                "activePullRequest": None,
                "activePrd": None,
                "activeMilestone": None,
            },
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, _ = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("  active phase: none", out)
        self.assertIn("  active issue: none", out)
        self.assertIn("  active pull request: none", out)
        self.assertIn("  active PRD: none", out)
        self.assertIn("  active milestone: none", out)

    def test_zero_active_issue_shows_zero(self):
        """activeIssue=0 → "0" (null-coalesce only defaults on None, not 0)."""
        _write_state(self.target, {
            "agentrailVersion": "1.0.0",
            "installedAt": "x",
            "updatedAt": "x",
            "legacyAdopted": False,
            "workflow": {"phase": "idle", "activeIssue": 0},
        })
        env = os.environ.copy()
        env.pop("AGENTRAIL_API_KEY", None)
        with patch.dict(os.environ, env, clear=True):
            out, _ = _capture(run_status, ["--target", str(self.target)])
        self.assertIn("  active issue: 0", out)


if __name__ == "__main__":
    unittest.main()
