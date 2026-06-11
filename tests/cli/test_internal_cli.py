"""Tests for ``agentrail internal`` command."""
from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch


def _git_ok(*args, **kwargs):
    """Fake _git that succeeds; returns toplevel for rev-parse."""
    result = MagicMock(returncode=0, stdout="", stderr="")
    if "rev-parse" in args:
        result.stdout = "/repo/root\n"
    return result


class TestReviewPrLegacyHatch(TestCase):
    """AGENTRAIL_NATIVE_REVIEW=0 keeps the legacy bash-exec path."""

    def _make_repo_with_script(self):
        tmp = tempfile.mkdtemp()
        script_dir = Path(tmp) / "templates" / "scripts"
        script_dir.mkdir(parents=True)
        script = script_dir / "review-pr"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o755)
        return tmp

    def test_native_review_0_execs_script(self):
        from agentrail.cli.commands.internal import run_internal

        tmp = self._make_repo_with_script()
        mock_proc = MagicMock(returncode=0)
        with patch.dict(os.environ, {"AGENTRAIL_NATIVE_REVIEW": "0"}), \
             patch("agentrail.cli.commands.internal._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.internal.subprocess.run", return_value=mock_proc) as mock_run:
            rc = run_internal(["review-pr", "--pr", "12", "--machine-readable"])
        self.assertEqual(rc, 0)
        call_args = mock_run.call_args[0][0]
        self.assertTrue(str(call_args[0]).endswith("review-pr"))
        self.assertIn("--pr", call_args)
        self.assertIn("12", call_args)
        self.assertIn("--machine-readable", call_args)

    def test_native_review_0_missing_script_returns_2(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        tmp = tempfile.mkdtemp()
        buf = io.StringIO()
        with patch.dict(os.environ, {"AGENTRAIL_NATIVE_REVIEW": "0"}), \
             patch("agentrail.cli.commands.internal._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            rc = run_internal(["review-pr", "--pr", "99"])
        self.assertEqual(rc, 2)
        self.assertIn("missing internal review helper", buf.getvalue())


class TestReviewPrNative(TestCase):
    """Default path runs natively (no bash script exec)."""

    def _env(self):
        return patch.dict(os.environ, {}, clear=False)

    def _common_patches(self, gh_meta=None):
        """Patch deps so the native path is NOT env-dependent (CI has no
        gh/codex/claude on PATH)."""
        if gh_meta is None:
            gh_meta = {
                "number": 12, "title": "Fix it", "url": "http://pr/12",
                "headRefName": "feat-x", "baseRefName": "main", "state": "OPEN",
            }
        return [
            patch("agentrail.cli.commands.internal.shutil.which", return_value="/usr/bin/x"),
            patch("agentrail.cli.commands.internal._git", side_effect=_git_ok),
            patch("agentrail.cli.commands.internal._gh_view", return_value=gh_meta),
        ]

    def test_native_path_builds_prompt_and_runs_review(self):
        from agentrail.cli.commands.internal import run_internal

        captured = {}

        def fake_build(pr, title, url, machine_readable, repo_root):
            captured["build"] = (pr, title, url, machine_readable)
            return "PROMPT WITH BEGIN_REVIEW_FIX_ISSUES_JSON"

        def fake_run_review(engine, base, pr, prompt, output, **kw):
            captured["run"] = (engine, base, pr, output)
            return 0

        with tempfile.TemporaryDirectory() as td:
            out = str(Path(td) / "out.md")
            patches = self._common_patches()
            with patches[0], patches[1], patches[2], \
                 patch("agentrail.afk.review_engine.build_review_prompt", fake_build), \
                 patch("agentrail.afk.review_engine.run_review", fake_run_review), \
                 patch("agentrail.afk.review_engine.validate_machine_readable_output") as mock_val:
                rc = run_internal([
                    "review-pr", "--pr", "12", "--engine", "codex",
                    "--output", out, "--machine-readable",
                ])
        self.assertEqual(rc, 0)
        self.assertEqual(captured["build"], ("12", "Fix it", "http://pr/12", True))
        self.assertEqual(captured["run"][0], "codex")
        self.assertEqual(captured["run"][1], "main")
        mock_val.assert_called_once()

    def test_machine_readable_requires_output(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal(["review-pr", "--pr", "12", "--machine-readable"])
        self.assertEqual(rc, 1)
        self.assertIn("--machine-readable requires --output", buf.getvalue())

    def test_unsupported_engine_returns_nonzero(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal(["review-pr", "--pr", "12", "--engine", "frob"])
        self.assertNotEqual(rc, 0)
        self.assertIn("unsupported review engine", buf.getvalue())

    def test_missing_dep_returns_nonzero(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        buf = io.StringIO()
        with patch("agentrail.cli.commands.internal.shutil.which", return_value=None), \
             patch("sys.stderr", buf):
            rc = run_internal(["review-pr", "--pr", "12"])
        self.assertNotEqual(rc, 0)
        self.assertIn("missing required command", buf.getvalue())

    def test_run_review_nonzero_propagates(self):
        from agentrail.cli.commands.internal import run_internal

        with tempfile.TemporaryDirectory() as td:
            out = str(Path(td) / "out.md")
            patches = self._common_patches()
            with patches[0], patches[1], patches[2], \
                 patch("agentrail.afk.review_engine.build_review_prompt", return_value="P"), \
                 patch("agentrail.afk.review_engine.run_review", return_value=3), \
                 patch("agentrail.afk.review_engine.validate_machine_readable_output") as mock_val:
                rc = run_internal([
                    "review-pr", "--pr", "12", "--output", out, "--machine-readable",
                ])
        self.assertEqual(rc, 3)
        mock_val.assert_not_called()

    def test_validation_failure_returns_nonzero(self):
        from agentrail.cli.commands.internal import run_internal
        from agentrail.afk.review_engine import ReviewError

        with tempfile.TemporaryDirectory() as td:
            out = str(Path(td) / "out.md")
            patches = self._common_patches()
            with patches[0], patches[1], patches[2], \
                 patch("agentrail.afk.review_engine.build_review_prompt", return_value="P"), \
                 patch("agentrail.afk.review_engine.run_review", return_value=0), \
                 patch("agentrail.afk.review_engine.validate_machine_readable_output",
                       side_effect=ReviewError("missing block")):
                rc = run_internal([
                    "review-pr", "--pr", "12", "--output", out, "--machine-readable",
                ])
        self.assertNotEqual(rc, 0)

    def test_missing_pr_returns_1(self):
        from agentrail.cli.commands.internal import run_internal
        import io

        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_internal(["review-pr"])
        self.assertEqual(rc, 1)


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
