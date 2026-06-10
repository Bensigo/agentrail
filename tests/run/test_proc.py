"""Unit tests for agentrail/run/proc.py.

Tests use sys.executable for portability — no bash dependency.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.run.proc import sanitized_env, ralph_executor_path, run_with_timeout


class SanitizedEnvTests(unittest.TestCase):
    def test_strips_claudecode_keeps_other(self) -> None:
        with patch.dict(os.environ, {"CLAUDECODE": "1", "KEEP_ME": "hello"}, clear=False):
            result = sanitized_env()
        self.assertNotIn("CLAUDECODE", result)
        self.assertIn("KEEP_ME", result)
        self.assertEqual(result["KEEP_ME"], "hello")

    def test_strips_all_agent_session_vars(self) -> None:
        agent_vars = {
            "CLAUDECODE": "1",
            "CLAUDE_CODE_SESSION_ID": "s",
            "CLAUDE_CODE_ENTRYPOINT": "e",
            "CLAUDE_AGENT_SDK_VERSION": "v",
            "CLAUDE_CODE_EXECPATH": "p",
            "CLAUDE_EFFORT": "high",
            "AI_AGENT": "1",
            "CODEX_SESSION": "c",
            "CODEX_SANDBOX": "sb",
            "CURSOR_SESSION": "cs",
            "CURSOR_AGENT": "ca",
        }
        with patch.dict(os.environ, agent_vars, clear=False):
            result = sanitized_env()
        for var in agent_vars:
            self.assertNotIn(var, result, f"{var} should be stripped")


class RalphExecutorPathTests(unittest.TestCase):
    def test_finds_script_in_target_scripts(self) -> None:
        with tempfile.TemporaryDirectory() as target_dir, \
             tempfile.TemporaryDirectory() as repo_dir:
            scripts = Path(target_dir) / "scripts"
            scripts.mkdir(parents=True)
            ralph = scripts / "ralph-loop"
            ralph.write_text("#!/bin/sh\n")
            ralph.chmod(0o755)
            result = ralph_executor_path(Path(target_dir), Path(repo_dir))
            self.assertEqual(result, ralph)

    def test_returns_none_when_not_found(self) -> None:
        with tempfile.TemporaryDirectory() as target_dir, \
             tempfile.TemporaryDirectory() as repo_dir:
            result = ralph_executor_path(Path(target_dir), Path(repo_dir))
            self.assertIsNone(result)

    def test_finds_installed_copy_in_agentrail_source(self) -> None:
        with tempfile.TemporaryDirectory() as target_dir, \
             tempfile.TemporaryDirectory() as repo_dir:
            installed = (
                Path(target_dir) / ".agentrail" / "source" / "templates" / "scripts"
            )
            installed.mkdir(parents=True)
            ralph = installed / "ralph-loop"
            ralph.write_text("#!/bin/sh\n")
            ralph.chmod(0o755)
            result = ralph_executor_path(Path(target_dir), Path(repo_dir))
            self.assertEqual(result, ralph)

    def test_prefers_installed_copy_over_repo_templates(self) -> None:
        with tempfile.TemporaryDirectory() as target_dir, \
             tempfile.TemporaryDirectory() as repo_dir:
            # installed copy
            installed = (
                Path(target_dir) / ".agentrail" / "source" / "templates" / "scripts"
            )
            installed.mkdir(parents=True)
            ralph_installed = installed / "ralph-loop"
            ralph_installed.write_text("#!/bin/sh\n")
            ralph_installed.chmod(0o755)
            # repo templates copy
            repo_templates = Path(repo_dir) / "templates" / "scripts"
            repo_templates.mkdir(parents=True)
            ralph_repo = repo_templates / "ralph-loop"
            ralph_repo.write_text("#!/bin/sh\n")
            ralph_repo.chmod(0o755)
            result = ralph_executor_path(Path(target_dir), Path(repo_dir))
            self.assertEqual(result, ralph_installed)


class RunWithTimeoutTests(unittest.TestCase):
    def test_success_returns_zero_and_writes_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "out.log"
            rc = run_with_timeout(
                [sys.executable, "-c", "print('hello-proc')"],
                cwd=tmp_path,
                timeout=30,
                output_file=out,
            )
            self.assertEqual(rc, 0)
            self.assertIn("hello-proc", out.read_text())

    def test_nonzero_exit_code_propagated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "out.log"
            rc = run_with_timeout(
                [sys.executable, "-c", "import sys; sys.exit(3)"],
                cwd=tmp_path,
                timeout=30,
                output_file=out,
            )
            self.assertEqual(rc, 3)

    def test_stdin_text_forwarded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "out.log"
            rc = run_with_timeout(
                [sys.executable, "-c", "import sys; sys.stdout.write(sys.stdin.read())"],
                cwd=tmp_path,
                timeout=30,
                output_file=out,
                stdin_text="echoed\n",
            )
            self.assertEqual(rc, 0)
            self.assertIn("echoed", out.read_text())

    def test_timeout_returns_124(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "out.log"
            rc = run_with_timeout(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                cwd=tmp_path,
                timeout=1,
                output_file=out,
            )
            self.assertEqual(rc, 124)

    def test_creates_parent_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "nested" / "dir" / "out.log"
            rc = run_with_timeout(
                [sys.executable, "-c", "print('nested-output')"],
                cwd=tmp_path,
                timeout=30,
                output_file=out,
            )
            self.assertEqual(rc, 0)
            self.assertTrue(out.exists())
            self.assertIn("nested-output", out.read_text())


if __name__ == "__main__":
    unittest.main()
