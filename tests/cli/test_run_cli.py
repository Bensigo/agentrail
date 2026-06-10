"""Unit tests for `agentrail run` CLI command (agentrail/cli/commands/run.py).

All external I/O (subprocess.run, gh, filesystem) is patched so these tests run
without an agent, gh, or a real repo.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from agentrail.cli.commands.run import run_run, AGENTS, DEFAULT_COMMANDS


class RunHelpTests(unittest.TestCase):
    def test_help_flag_prints_usage_and_exits_zero(self) -> None:
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                with patch("builtins.print") as mock_print:
                    rc = run_run([flag])
                self.assertEqual(rc, 0)
                printed = " ".join(str(c) for c in mock_print.call_args_list)
                self.assertIn("Usage:", printed)

    def test_agent_allowlist_and_defaults_present(self) -> None:
        self.assertEqual(AGENTS, {"codex", "claude", "cursor", "hermes", "custom"})
        self.assertEqual(DEFAULT_COMMANDS["claude"], "claude -p --dangerously-skip-permissions")
        self.assertEqual(DEFAULT_COMMANDS["custom"], "")
