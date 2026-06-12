"""Tests for the context-first PreToolUse hook (#519, hard mode).

Drives ``templates/scripts/context-first.sh`` directly via ``subprocess`` with
fixture stdin payloads shaped like Claude Code's PreToolUse hook JSON. Hard mode
denies every broad search (``Grep``/``Glob`` tools and Bash ``grep``/``rg``/
``find``) outright — there is no marker escape — while non-search tools, Read,
non-matching Bash, and malformed input all pass.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[2] / "templates" / "scripts" / "context-first.sh"

FEEDBACK = (
    "Repo-wide search is disabled (AgentRail hard mode). Use "
    '`agentrail context query "<your term>" --json` for ranked retrieval, then '
    "Read the cited files. The Grep/Glob tools and bare grep/rg/find are blocked."
)


def _run(payload: dict, project_dir: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["CLAUDE_PROJECT_DIR"] = str(project_dir)
    return subprocess.run(
        [str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )


class ContextFirstHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp())

    def _marker(self) -> Path:
        marker = self.project / ".agentrail" / "tmp" / "context-queried"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        return marker

    # --- broad searches are always blocked with the redirect message ---------

    def test_grep_tool_blocked(self):
        result = _run({"tool_name": "Grep", "tool_input": {"pattern": "foo"}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_glob_tool_blocked(self):
        result = _run({"tool_name": "Glob", "tool_input": {"pattern": "**/*.py"}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_bash_grep_blocked(self):
        result = _run({"tool_name": "Bash", "tool_input": {"command": "grep -r foo ."}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_bash_rg_blocked(self):
        result = _run({"tool_name": "Bash", "tool_input": {"command": "rg foo"}}, self.project)
        self.assertEqual(result.returncode, 2)

    def test_bash_find_blocked(self):
        result = _run({"tool_name": "Bash", "tool_input": {"command": "find . -name '*.py'"}}, self.project)
        self.assertEqual(result.returncode, 2)

    # --- hard mode: a prior context query (marker) does NOT re-enable grep ----

    def test_grep_tool_blocked_even_with_marker(self):
        self._marker()
        result = _run({"tool_name": "Grep", "tool_input": {"pattern": "foo"}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_bash_grep_blocked_even_with_marker(self):
        self._marker()
        result = _run({"tool_name": "Bash", "tool_input": {"command": "grep -r foo ."}}, self.project)
        self.assertEqual(result.returncode, 2)

    # --- non-search tools / commands always pass ------------------------------

    def test_non_matching_bash_passes(self):
        for command in ("git status", "pytest", "agentrail context query foo", "ls -la", "cat file"):
            with self.subTest(command=command):
                result = _run({"tool_name": "Bash", "tool_input": {"command": command}}, self.project)
                self.assertEqual(result.returncode, 0, command)

    def test_grepish_substring_not_at_start_passes(self):
        # `egrep`/`agrep` and grep-not-at-start must not be gated.
        for command in ("echo grep", "mygrep foo", "git log | grep foo"):
            with self.subTest(command=command):
                result = _run({"tool_name": "Bash", "tool_input": {"command": command}}, self.project)
                self.assertEqual(result.returncode, 0, command)

    def test_read_tool_always_passes(self):
        result = _run({"tool_name": "Read", "tool_input": {"file_path": "x"}}, self.project)
        self.assertEqual(result.returncode, 0)

    def test_malformed_json_passes(self):
        env = dict(os.environ)
        env["CLAUDE_PROJECT_DIR"] = str(self.project)
        result = subprocess.run(
            [str(HOOK)], input="not json", capture_output=True, text=True, env=env
        )
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
