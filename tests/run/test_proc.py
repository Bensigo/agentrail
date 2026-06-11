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

from agentrail.run.proc import sanitized_env, run_with_timeout


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
