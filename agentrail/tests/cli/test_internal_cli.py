"""Tests for ``agentrail internal`` command."""
from __future__ import annotations

import os
from unittest import TestCase
from unittest.mock import MagicMock, patch


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
        """run_internal is mocked here — this only pins that `main` passes the
        tail args through unchanged; it does not exercise a real subcommand."""
        from agentrail.cli import main as m

        with patch.object(m, "run_internal", return_value=0) as mock_ri:
            result = m.main(["internal", "worktree", "mark", "--path", "x"])
        mock_ri.assert_called_once_with(["worktree", "mark", "--path", "x"])
        self.assertEqual(result, 0)
