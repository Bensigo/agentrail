"""Tests for the context-first PreToolUse hook (#519).

Drives ``templates/scripts/context-first.sh`` directly via ``subprocess`` with
fixture stdin payloads shaped like Claude Code's PreToolUse hook JSON, asserting
the block-then-allow behavior, the exact redirect feedback text, and that
non-matching Bash commands always pass.
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
    'Use `agentrail context query "<your term>" --json` first — ranked retrieval '
    "is cheaper than repo-wide grep. Grep is allowed after retrieval has been tried."
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

    # --- AC1: first broad grep blocked with redirect message -----------------

    def test_grep_tool_blocked_without_marker(self):
        result = _run({"tool_name": "Grep", "tool_input": {"pattern": "foo"}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_glob_tool_blocked_without_marker(self):
        result = _run({"tool_name": "Glob", "tool_input": {"pattern": "**/*.py"}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_bash_grep_blocked_without_marker(self):
        result = _run({"tool_name": "Bash", "tool_input": {"command": "grep -r foo ."}}, self.project)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), FEEDBACK)

    def test_bash_rg_blocked_without_marker(self):
        result = _run({"tool_name": "Bash", "tool_input": {"command": "rg foo"}}, self.project)
        self.assertEqual(result.returncode, 2)

    def test_bash_find_blocked_without_marker(self):
        result = _run({"tool_name": "Bash", "tool_input": {"command": "find . -name '*.py'"}}, self.project)
        self.assertEqual(result.returncode, 2)

    # --- AC2: marker honored; non-matching Bash always passes -----------------

    def test_grep_tool_allowed_with_marker(self):
        self._marker()
        result = _run({"tool_name": "Grep", "tool_input": {"pattern": "foo"}}, self.project)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")

    def test_bash_grep_allowed_with_marker(self):
        self._marker()
        result = _run({"tool_name": "Bash", "tool_input": {"command": "grep -r foo ."}}, self.project)
        self.assertEqual(result.returncode, 0)

    def test_non_matching_bash_passes_without_marker(self):
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
