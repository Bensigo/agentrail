"""Tests for ``agentrail memory`` command."""
from __future__ import annotations

import io
import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch


def _make_repo_with_memory_script() -> str:
    """Create a temp repo dir with an executable templates/scripts/memory."""
    tmp = tempfile.mkdtemp()
    scripts_dir = Path(tmp) / "templates" / "scripts"
    scripts_dir.mkdir(parents=True)
    memory_script = scripts_dir / "memory"
    memory_script.write_text("#!/bin/sh\nexit 0\n")
    memory_script.chmod(0o755)
    return tmp


class TestRunMemory(TestCase):

    # ------------------------------------------------------------------
    # empty args → rc 1 + usage on stderr
    # ------------------------------------------------------------------
    def test_empty_args_returns_1(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_memory([])
        self.assertEqual(rc, 1)
        self.assertIn("Usage", buf.getvalue())

    # ------------------------------------------------------------------
    # -h / --help → rc 0 + usage on stdout
    # ------------------------------------------------------------------
    def test_help_short_returns_0(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_memory(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    def test_help_long_returns_0(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_memory(["--help"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    # ------------------------------------------------------------------
    # memory present: runs script with correct argv and cwd
    # ------------------------------------------------------------------
    def test_memory_present_runs_script(self):
        from agentrail.cli.commands.memory import run_memory

        tmp = _make_repo_with_memory_script()
        mock_proc = MagicMock(returncode=0)
        with patch("agentrail.cli.commands.memory._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.memory.subprocess.run", return_value=mock_proc) as mock_run:
            rc = run_memory(["recall", "query", "--target", "/x"])
        self.assertEqual(rc, 0)
        call_args = mock_run.call_args
        call_argv = call_args[0][0]
        call_cwd = call_args[1]["cwd"]
        # script is first, then kind, then passthrough (--target consumed)
        self.assertTrue(str(call_argv[0]).endswith("memory"),
                        f"expected memory script, got {call_argv[0]}")
        self.assertEqual(call_argv[1], "recall")
        self.assertIn("query", call_argv)
        self.assertNotIn("--target", call_argv)
        self.assertNotIn("/x", call_argv)
        self.assertEqual(call_cwd, "/x")

    # ------------------------------------------------------------------
    # --target consumed; other --flags passed through as-is
    # ------------------------------------------------------------------
    def test_unknown_flags_passed_through(self):
        from agentrail.cli.commands.memory import run_memory

        tmp = _make_repo_with_memory_script()
        mock_proc = MagicMock(returncode=0)
        with patch("agentrail.cli.commands.memory._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.memory.subprocess.run", return_value=mock_proc) as mock_run:
            rc = run_memory(["save", "--foo", "bar"])
        self.assertEqual(rc, 0)
        call_argv = mock_run.call_args[0][0]
        # argv should be [script, "save", "--foo", "bar"]
        self.assertEqual(call_argv[1], "save")
        self.assertIn("--foo", call_argv)
        self.assertIn("bar", call_argv)

    # ------------------------------------------------------------------
    # --target without value → rc 2 + stderr
    # ------------------------------------------------------------------
    def test_target_missing_value_returns_2(self):
        from agentrail.cli.commands.memory import run_memory

        tmp = _make_repo_with_memory_script()
        buf = io.StringIO()
        with patch("agentrail.cli.commands.memory._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            rc = run_memory(["recall", "--target"])
        self.assertEqual(rc, 2)
        self.assertIn("--target requires a directory", buf.getvalue())

    def test_target_followed_by_flag_returns_2(self):
        from agentrail.cli.commands.memory import run_memory

        tmp = _make_repo_with_memory_script()
        buf = io.StringIO()
        with patch("agentrail.cli.commands.memory._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            rc = run_memory(["recall", "--target", "--other"])
        self.assertEqual(rc, 2)
        self.assertIn("--target requires a directory", buf.getvalue())

    # ------------------------------------------------------------------
    # missing script → rc 1 + stderr
    # ------------------------------------------------------------------
    def test_missing_script_returns_1(self):
        from agentrail.cli.commands.memory import run_memory

        tmp = tempfile.mkdtemp()  # empty — no templates/scripts/memory
        buf = io.StringIO()
        with patch("agentrail.cli.commands.memory._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            rc = run_memory(["recall"])
        self.assertEqual(rc, 1)
        self.assertIn("missing internal memory helper", buf.getvalue())

    # ------------------------------------------------------------------
    # passthrough returncode: subprocess rc propagated
    # ------------------------------------------------------------------
    def test_passthrough_returncode(self):
        from agentrail.cli.commands.memory import run_memory

        tmp = _make_repo_with_memory_script()
        mock_proc = MagicMock(returncode=5)
        with patch("agentrail.cli.commands.memory._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.memory.subprocess.run", return_value=mock_proc):
            rc = run_memory(["recall"])
        self.assertEqual(rc, 5)

    # ------------------------------------------------------------------
    # -h in middle of args (after kind) → usage + rc 0
    # ------------------------------------------------------------------
    def test_help_in_rest_returns_0(self):
        from agentrail.cli.commands.memory import run_memory

        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_memory(["recall", "-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", buf.getvalue())

    # ------------------------------------------------------------------
    # main routes memory → run_memory
    # ------------------------------------------------------------------
    def test_main_routes_memory(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_memory", return_value=0) as mock_rm:
            rc = m.main(["memory", "recall", "query"])
        mock_rm.assert_called_once_with(["recall", "query"])
        self.assertEqual(rc, 0)
