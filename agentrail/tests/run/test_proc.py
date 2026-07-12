"""Unit tests for agentrail/run/proc.py.

Tests use sys.executable for portability — no bash dependency.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
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

    @unittest.skipUnless(
        hasattr(os, "killpg") and hasattr(os, "setsid"),
        "process-group semantics are POSIX-only",
    )
    def test_timeout_reaps_grandchildren_promptly(self) -> None:
        # The child spawns a GRANDCHILD that inherits the stdout pipe and
        # sleeps ~8s, then the child itself hangs. Killing only the direct
        # child leaves the grandchild holding the pipe's write end, so the
        # reader thread never sees EOF and join() blocks for the grandchild's
        # full lifetime — the 1s timeout silently becomes ~8s. Group-kill
        # must reap the whole tree: rc 124 AND a prompt return.
        child_src = (
            "import subprocess, sys, time; "
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(8)']); "
            "print('spawned', flush=True); "
            "time.sleep(30)"
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "out.log"
            start = time.monotonic()
            rc = run_with_timeout(
                [sys.executable, "-c", child_src],
                cwd=tmp_path,
                timeout=1,
                output_file=out,
            )
            elapsed = time.monotonic() - start
            self.assertEqual(rc, 124)
            self.assertLess(
                elapsed, 6.0,
                f"timeout took {elapsed:.1f}s — a surviving grandchild wedged the reader thread",
            )

    @unittest.skipUnless(
        hasattr(os, "killpg") and hasattr(os, "setsid"),
        "process-group semantics are POSIX-only",
    )
    def test_success_exit_reaps_lingering_grandchildren(self) -> None:
        # The child exits 0 immediately but leaves behind a GRANDCHILD that
        # inherited the stdout pipe and keeps sleeping. The child succeeded,
        # so this must NOT be treated as a timeout — but the write end of
        # the pipe stays open until the grandchild exits, so an unbounded
        # reader.join() on the success path blocks for the grandchild's
        # full lifetime. A verify check that backgrounds a dev server and
        # exits 0 would wedge the caller (and the whole verify gate)
        # indefinitely. The success path must bound the join and reap the
        # group, while still reporting the child's real (successful) rc.
        child_src = (
            "import subprocess, sys; "
            "print('success-marker', flush=True); "
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(8)']); "
            "sys.exit(0)"
        )
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            out = tmp_path / "out.log"
            start = time.monotonic()
            rc = run_with_timeout(
                [sys.executable, "-c", child_src],
                cwd=tmp_path,
                timeout=30,
                output_file=out,
            )
            elapsed = time.monotonic() - start
            self.assertEqual(rc, 0)
            self.assertIn("success-marker", out.read_text())
            self.assertLess(
                elapsed, 6.0,
                f"success exit took {elapsed:.1f}s — a lingering grandchild wedged the reader thread",
            )


if __name__ == "__main__":
    unittest.main()
