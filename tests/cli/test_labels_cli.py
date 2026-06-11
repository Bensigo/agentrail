"""Tests for ``agentrail labels`` command."""
from __future__ import annotations

import io
import sys
from unittest import TestCase
from unittest.mock import MagicMock, call, patch


class _Proc:
    """Minimal subprocess.CompletedProcess stand-in."""

    def __init__(self, returncode: int = 0, stdout: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout


class TestLabelsSyncHappyPath(TestCase):
    def _run_sync(self, extra_args=None):
        from agentrail.cli.commands.labels import run_labels

        extra_args = extra_args or []
        buf = io.StringIO()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "gh" and cmd[1] == "auth":
                return _Proc(0)
            if cmd[0] == "git":
                return _Proc(0, stdout="git@github.com:owner/repo.git")
            # gh label create
            return _Proc(0)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/usr/bin/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run) as mock_run, \
             patch("sys.stdout", buf):
            rc = run_labels(["sync"] + extra_args)

        return rc, buf.getvalue(), mock_run

    def test_returns_0(self):
        rc, _, _ = self._run_sync()
        self.assertEqual(rc, 0)

    def test_prints_ok(self):
        _, out, _ = self._run_sync()
        self.assertIn("labels sync: ok", out)

    def test_six_label_create_calls(self):
        _, _, mock_run = self._run_sync()
        label_calls = [
            c for c in mock_run.call_args_list
            if c[0][0][0] == "gh" and "label" in c[0][0]
        ]
        self.assertEqual(len(label_calls), 6)

    def test_exact_label_names_colors_descriptions(self):
        from agentrail.cli.commands.labels import LABELS
        _, _, mock_run = self._run_sync()
        label_calls = [
            c[0][0]  # positional cmd list
            for c in mock_run.call_args_list
            if c[0][0][0] == "gh" and "label" in c[0][0]
        ]
        for name, color, desc in LABELS:
            matched = [c for c in label_calls if name in c]
            self.assertEqual(len(matched), 1, f"expected exactly one call for label '{name}'")
            cmd = matched[0]
            self.assertIn("--color", cmd)
            self.assertIn(color, cmd)
            self.assertIn("--description", cmd)
            self.assertIn(desc, cmd)
            self.assertIn("--force", cmd)

    def test_target_honored_as_cwd(self):
        from agentrail.cli.commands.labels import run_labels

        calls_received = []

        def fake_run(cmd, **kwargs):
            calls_received.append((cmd, kwargs))
            if cmd[0] == "gh" and cmd[1] == "auth":
                return _Proc(0)
            if cmd[0] == "git":
                return _Proc(0, stdout="git@github.com:x/y.git")
            return _Proc(0)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run), \
             patch("sys.stdout", io.StringIO()):
            rc = run_labels(["sync", "--target", "/some/project"])

        self.assertEqual(rc, 0)
        # auth check and label creates should use target as cwd
        for cmd, kw in calls_received:
            if cmd[0] == "gh":
                self.assertEqual(kw.get("cwd"), "/some/project",
                                 f"expected cwd=/some/project for {cmd}")


class TestLabelsSyncGhMissing(TestCase):
    def test_returns_1(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("agentrail.cli.commands.labels.shutil.which", return_value=None), \
             patch("sys.stderr", buf):
            rc = run_labels(["sync"])
        self.assertEqual(rc, 1)

    def test_stderr_message(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("agentrail.cli.commands.labels.shutil.which", return_value=None), \
             patch("sys.stderr", buf):
            run_labels(["sync"])
        self.assertIn("gh CLI is required", buf.getvalue())

    def test_no_label_create_calls(self):
        from agentrail.cli.commands.labels import run_labels
        with patch("agentrail.cli.commands.labels.shutil.which", return_value=None), \
             patch("agentrail.cli.commands.labels.subprocess.run") as mock_run, \
             patch("sys.stderr", io.StringIO()):
            run_labels(["sync"])
        mock_run.assert_not_called()


class TestLabelsSyncNotAuthenticated(TestCase):
    def test_returns_1(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "gh" and cmd[1] == "auth":
                return _Proc(1)
            return _Proc(0)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run), \
             patch("sys.stderr", buf):
            rc = run_labels(["sync"])
        self.assertEqual(rc, 1)

    def test_stderr_message(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()

        def fake_run(cmd, **kwargs):
            return _Proc(1)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run), \
             patch("sys.stderr", buf):
            run_labels(["sync"])
        self.assertIn("not authenticated", buf.getvalue())


class TestLabelsSyncNonGithubRemote(TestCase):
    def test_returns_1(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "gh" and cmd[1] == "auth":
                return _Proc(0)
            if cmd[0] == "git":
                return _Proc(0, stdout="git@gitlab.com:owner/repo.git")
            return _Proc(0)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run), \
             patch("sys.stderr", buf):
            rc = run_labels(["sync"])
        self.assertEqual(rc, 1)

    def test_stderr_message(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "gh" and cmd[1] == "auth":
                return _Proc(0)
            if cmd[0] == "git":
                return _Proc(0, stdout="git@gitlab.com:owner/repo.git")
            return _Proc(0)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run), \
             patch("sys.stderr", buf):
            run_labels(["sync"])
        self.assertIn("does not have a GitHub origin remote", buf.getvalue())

    def test_git_remote_rc_nonzero_returns_1(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "gh" and cmd[1] == "auth":
                return _Proc(0)
            if cmd[0] == "git":
                return _Proc(128, stdout="")
            return _Proc(0)

        with patch("agentrail.cli.commands.labels.shutil.which", return_value="/gh"), \
             patch("agentrail.cli.commands.labels.subprocess.run", side_effect=fake_run), \
             patch("sys.stderr", buf):
            rc = run_labels(["sync"])
        self.assertEqual(rc, 1)
        self.assertIn("does not have a GitHub origin remote", buf.getvalue())


class TestLabelsDispatch(TestCase):
    def test_unknown_subcommand_returns_2(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_labels(["frob"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown labels command: frob", buf.getvalue())

    def test_empty_args_returns_0(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_labels([])
        self.assertEqual(rc, 0)

    def test_dash_h_returns_0(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_labels(["-h"])
        self.assertEqual(rc, 0)

    def test_double_help_returns_0(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            rc = run_labels(["--help"])
        self.assertEqual(rc, 0)

    def test_unknown_option_returns_2(self):
        from agentrail.cli.commands.labels import run_labels
        buf = io.StringIO()
        with patch("sys.stderr", buf):
            rc = run_labels(["sync", "--bogus"])
        self.assertEqual(rc, 2)


class TestMainRoutesLabels(TestCase):
    def test_main_routes_labels(self):
        from agentrail.cli import main as m

        with patch.object(m, "run_labels", return_value=0) as mock_rl:
            result = m.main(["labels", "sync"])
        mock_rl.assert_called_once_with(["sync"])
        self.assertEqual(result, 0)
