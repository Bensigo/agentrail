"""Tests for ``agentrail init`` / ``agentrail install`` commands."""
from __future__ import annotations

import io
import os
import stat
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch


class TestRunInstall(TestCase):
    def _make_repo_with_installer(self) -> str:
        """Create a temp repo dir with an executable scripts/install-workflow."""
        tmp = tempfile.mkdtemp()
        scripts_dir = Path(tmp) / "scripts"
        scripts_dir.mkdir(parents=True)
        installer = scripts_dir / "install-workflow"
        installer.write_text("#!/bin/sh\nexit 0\n")
        installer.chmod(0o755)
        return tmp

    # ------------------------------------------------------------------
    # install present: runs installer with passthrough args
    # ------------------------------------------------------------------
    def test_install_present_runs_installer(self):
        from agentrail.cli.commands.install import run_install

        tmp = self._make_repo_with_installer()
        mock_proc = MagicMock(returncode=0)
        with patch("agentrail.cli.commands.install._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.install.subprocess.run", return_value=mock_proc) as mock_run:
            rc = run_install(["--target", "/x", "--force"])
        self.assertEqual(rc, 0)
        call_argv = mock_run.call_args[0][0]
        self.assertTrue(str(call_argv[0]).endswith("install-workflow"),
                        f"expected install-workflow, got {call_argv[0]}")
        self.assertIn("--target", call_argv)
        self.assertIn("/x", call_argv)
        self.assertIn("--force", call_argv)

    # ------------------------------------------------------------------
    # install missing: returns 2 and writes stderr
    # ------------------------------------------------------------------
    def test_install_missing_returns_2(self):
        from agentrail.cli.commands.install import run_install

        tmp = tempfile.mkdtemp()  # empty dir — no scripts/install-workflow
        buf = io.StringIO()
        with patch("agentrail.cli.commands.install._repo_dir", return_value=Path(tmp)), \
             patch("sys.stderr", buf):
            rc = run_install([])
        self.assertEqual(rc, 2)
        self.assertIn("missing installer", buf.getvalue())

    # ------------------------------------------------------------------
    # passthrough returncode: subprocess rc propagated
    # ------------------------------------------------------------------
    def test_passthrough_returncode(self):
        from agentrail.cli.commands.install import run_install

        tmp = self._make_repo_with_installer()
        mock_proc = MagicMock(returncode=3)
        with patch("agentrail.cli.commands.install._repo_dir", return_value=Path(tmp)), \
             patch("agentrail.cli.commands.install.subprocess.run", return_value=mock_proc):
            rc = run_install(["--github-labels"])
        self.assertEqual(rc, 3)

    # ------------------------------------------------------------------
    # main routes: both "init" and "install" dispatch to run_install
    # ------------------------------------------------------------------
    def test_main_routes_init(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_install", return_value=0) as mock_ri:
            rc = m.main(["init", "--target", "/x"])
        mock_ri.assert_called_once_with(["--target", "/x"])
        self.assertEqual(rc, 0)

    def test_main_routes_install(self):
        import agentrail.cli.main as m
        with patch("agentrail.cli.main.run_install", return_value=0) as mock_ri:
            rc = m.main(["install", "--github-labels"])
        mock_ri.assert_called_once_with(["--github-labels"])
        self.assertEqual(rc, 0)
