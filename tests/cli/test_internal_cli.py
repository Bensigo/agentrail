"""Tests for ``agentrail internal`` command."""
from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch


class TestReviewPr(TestCase):
    def _make_repo_with_script(self, returncode: int = 0):
        tmp = tempfile.mkdtemp()
        script_dir = Path(tmp) / "templates" / "scripts"
        script_dir.mkdir(parents=True)
        script = script_dir / "review-pr"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o755)
        return tmp

    def test_review_pr_present_runs_script(self):
        from agentrail.cli.commands.internal import run_internal

        tmp = self._make_repo_with_script()
        mock_proc = MagicMock(returncode=0)
        with patch("agentrail.cli.commands.internal._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.internal.subprocess.run", return_value=mock_proc) as mock_run:
            rc = run_internal(["review-pr", "--pr", "12", "--machine-readable"])
        self.assertEqual(rc, 0)
        call_args = mock_run.call_args[0][0]
        self.assertTrue(str(call_args[0]).endswith("review-pr"))
        self.assertIn("--pr", call_args)
        self.assertIn("12", call_args)
        self.assertIn("--machine-readable", call_args)

    def test_review_pr_missing_returns_2(self):
        from agentrail.cli.commands.internal import run_internal

        tmp = tempfile.mkdtemp()
        with patch("agentrail.cli.commands.internal._repo_dir", return_value=Path(tmp)):
            with patch("sys.stderr") as mock_err:
                rc = run_internal(["review-pr", "--pr", "99"])
        self.assertEqual(rc, 2)

    def test_review_pr_missing_writes_stderr(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        tmp = tempfile.mkdtemp()
        buf = io.StringIO()
        with patch("agentrail.cli.commands.internal._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            run_internal(["review-pr", "--pr", "99"])
        self.assertIn("missing internal review helper", buf.getvalue())

    def test_review_pr_nonexec_returns_2(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        tmp = tempfile.mkdtemp()
        script_dir = Path(tmp) / "templates" / "scripts"
        script_dir.mkdir(parents=True)
        script = script_dir / "review-pr"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o644)  # not executable
        buf = io.StringIO()
        with patch("agentrail.cli.commands.internal._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            rc = run_internal(["review-pr"])
        self.assertEqual(rc, 2)
        self.assertIn("missing internal review helper", buf.getvalue())


class TestWorktreeMark(TestCase):
    def _patched(self, args, mock_uws):
        with patch("agentrail.cli.commands.internal.update_worktree_state", mock_uws):
            from agentrail.cli.commands.internal import run_internal
            return run_internal(args)

    def test_worktree_mark_basic(self):
        from agentrail.cli.commands.internal import run_internal

        mock_uws = MagicMock()
        with patch("agentrail.cli.commands.internal.update_worktree_state", mock_uws):
            rc = run_internal([
                "worktree", "mark",
                "--target", "/tmp/t",
                "--path", "/tmp/t/wt",
                "--status", "running",
                "--issue", "12",
                "--slot", "1",
            ])
        self.assertEqual(rc, 0)
        mock_uws.assert_called_once()
        call_kwargs = mock_uws.call_args
        # positional: target, worktree_path, status
        args_pos = call_kwargs[0]
        # target is resolved via Path.resolve(); absolute wt_path is passed through as-is
        self.assertEqual(str(args_pos[0]), os.path.realpath("/tmp/t"))
        self.assertEqual(args_pos[1], "/tmp/t/wt")
        self.assertEqual(args_pos[2], "running")
        # keyword
        kw = call_kwargs[1]
        self.assertEqual(kw["issue"], 12)
        self.assertEqual(kw["slot"], 1)

    def test_worktree_mark_relative_path_joined_to_target(self):
        from agentrail.cli.commands.internal import run_internal

        mock_uws = MagicMock()
        with patch("agentrail.cli.commands.internal.update_worktree_state", mock_uws):
            rc = run_internal([
                "worktree", "mark",
                "--target", "/tmp/myrepo",
                "--path", "worktrees/slot-1",
                "--status", "queued",
            ])
        self.assertEqual(rc, 0)
        args_pos = mock_uws.call_args[0]
        # Use realpath to handle macOS /tmp -> /private/tmp symlink
        self.assertEqual(args_pos[1], os.path.realpath("/tmp/myrepo") + "/worktrees/slot-1")

    def test_worktree_mark_missing_path_returns_2(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        mock_uws = MagicMock()
        with patch("agentrail.cli.commands.internal.update_worktree_state", mock_uws), \
             patch("sys.stderr", buf):
            rc = run_internal(["worktree", "mark", "--target", "/tmp/t", "--status", "running"])
        self.assertEqual(rc, 2)
        self.assertIn("--path", buf.getvalue())

    def test_worktree_mark_missing_status_returns_2(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        mock_uws = MagicMock()
        with patch("agentrail.cli.commands.internal.update_worktree_state", mock_uws), \
             patch("sys.stderr", buf):
            rc = run_internal(["worktree", "mark", "--target", "/tmp/t", "--path", "/tmp/t/wt"])
        self.assertEqual(rc, 2)
        self.assertIn("--status", buf.getvalue())

    def test_worktree_mark_invalid_status_returns_2(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("agentrail.cli.commands.internal.update_worktree_state",
                   side_effect=ValueError("invalid worktree lifecycle status: badstatus")), \
             patch("sys.stderr", buf):
            rc = run_internal([
                "worktree", "mark",
                "--path", "/tmp/t/wt",
                "--status", "badstatus",
            ])
        self.assertEqual(rc, 2)
        self.assertIn("invalid worktree lifecycle status", buf.getvalue())

    def test_worktree_unknown_action_returns_2(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal(["worktree", "list"])
        self.assertEqual(rc, 2)
        self.assertIn("unknown internal worktree action: list", buf.getvalue())

    def test_worktree_no_action_returns_2(self):
        from agentrail.cli.commands.internal import run_internal
        rc = run_internal(["worktree"])
        self.assertEqual(rc, 2)

    def test_flag_missing_value_returns_2(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal(["worktree", "mark", "--path"])
        self.assertEqual(rc, 2)
        self.assertIn("--path requires", buf.getvalue())


class TestDispatch(TestCase):
    def test_empty_args_returns_1(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal([])
        self.assertEqual(rc, 1)
        self.assertIn("Usage", buf.getvalue())

    def test_help_flag_returns_0(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_internal(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    def test_help_long_flag_returns_0(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_internal(["--help"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    def test_unknown_command_returns_2(self):
        import io
        from agentrail.cli.commands.internal import run_internal

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal(["frobnicate"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown internal command: frobnicate", buf.getvalue())


class TestMainRoutes(TestCase):
    def test_main_routes_internal(self):
        from agentrail.cli import main as m

        with patch.object(m, "run_internal", return_value=0) as mock_ri:
            result = m.main(["internal", "review-pr", "--pr", "1"])
        mock_ri.assert_called_once_with(["review-pr", "--pr", "1"])
        self.assertEqual(result, 0)
