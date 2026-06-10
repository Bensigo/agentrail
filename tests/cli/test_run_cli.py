"""Unit tests for `agentrail run` CLI command (agentrail/cli/commands/run.py).

All external I/O (subprocess.run, gh, filesystem) is patched so these tests run
without an agent, gh, or a real repo.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from agentrail.cli.commands.run import run_run, AGENTS, DEFAULT_COMMANDS, parse_run_options, UsageError


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

    def test_all_agents_have_default_commands(self) -> None:
        for agent in AGENTS:
            self.assertIn(agent, DEFAULT_COMMANDS,
                          f"Agent '{agent}' missing from DEFAULT_COMMANDS")


class ParseRunOptionsTests(unittest.TestCase):
    def test_defaults(self) -> None:
        opts = parse_run_options([])
        self.assertEqual(opts.agent, "__config__")
        self.assertEqual(opts.command, "")
        self.assertEqual(opts.log_dir, "")
        # target defaults to cwd
        self.assertTrue(opts.target)

    def test_all_flags(self) -> None:
        opts = parse_run_options(
            ["--agent", "claude", "--target", "/tmp/x",
             "--command", "claude -p", "--log-dir", "/tmp/logs"])
        self.assertEqual(opts.agent, "claude")
        self.assertEqual(opts.target, "/tmp/x")
        self.assertEqual(opts.command, "claude -p")
        self.assertEqual(opts.log_dir, "/tmp/logs")

    def test_bad_agent_rejected(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            parse_run_options(["--agent", "bogus"])
        self.assertEqual(ctx.exception.code, 2)

    def test_flag_missing_value_rejected(self) -> None:
        for flag in ("--agent", "--target", "--command", "--log-dir"):
            with self.subTest(flag=flag):
                with self.assertRaises(UsageError):
                    parse_run_options([flag])

    def test_unknown_option_rejected(self) -> None:
        with self.assertRaises(UsageError):
            parse_run_options(["--nope"])
