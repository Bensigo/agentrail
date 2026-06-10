"""Unit tests for `agentrail run` CLI command (agentrail/cli/commands/run.py).

All external I/O (subprocess.run, gh, filesystem) is patched so these tests run
without an agent, gh, or a real repo.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.cli.commands.run import (
    run_run, AGENTS, DEFAULT_COMMANDS, parse_run_options, UsageError,
    resolve_agent_name, resolve_agent_command,
    is_source_checkout, ensure_source_run_allowed,
)


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


class ResolveAgentTests(unittest.TestCase):
    def _cfg(self, data: dict) -> str:
        d = tempfile.mkdtemp()
        (Path(d) / ".agentrail").mkdir()
        (Path(d) / ".agentrail" / "config.json").write_text(json.dumps(data))
        return d

    def test_name_explicit_fallback_wins(self) -> None:
        self.assertEqual(resolve_agent_name("/nope", "claude"), "claude")

    def test_name_from_config_runner(self) -> None:
        d = self._cfg({"runner": {"name": "cursor"}})
        self.assertEqual(resolve_agent_name(d, "__config__"), "cursor")

    def test_name_default_codex_when_no_config(self) -> None:
        self.assertEqual(resolve_agent_name("/nope", "__config__"), "codex")

    def test_command_explicit_wins(self) -> None:
        self.assertEqual(resolve_agent_command("claude", "my-cmd", "/nope"), "my-cmd")

    def test_command_config_runner_when_config_sentinel(self) -> None:
        d = self._cfg({"runner": {"command": "cfg-cmd"}})
        self.assertEqual(resolve_agent_command("__config__", "", d), "cfg-cmd")

    def test_command_runners_map(self) -> None:
        d = self._cfg({"runners": {"claude": {"command": "map-cmd"}}})
        self.assertEqual(resolve_agent_command("claude", "", d), "map-cmd")

    def test_command_env_agent_specific(self) -> None:
        with patch.dict(os.environ, {"AGENTRAIL_CLAUDE_COMMAND": "env-cmd"}, clear=False):
            self.assertEqual(resolve_agent_command("claude", "", "/nope"), "env-cmd")

    def test_command_default(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_agent_command("claude", "", "/nope"),
                             DEFAULT_COMMANDS["claude"])


class SourceGuardTests(unittest.TestCase):
    def _make_source(self) -> str:
        d = tempfile.mkdtemp()
        p = Path(d)
        (p / "package.json").write_text(json.dumps({"name": "@bensigo/agentrail"}))
        (p / "templates" / "scripts").mkdir(parents=True)
        (p / "scripts").mkdir()
        exe = p / "scripts" / "agentrail"
        exe.write_text("#!/bin/sh\n"); exe.chmod(0o755)
        return d

    def test_detects_source_checkout(self) -> None:
        self.assertTrue(is_source_checkout(self._make_source()))

    def test_non_source_dir_is_false(self) -> None:
        self.assertFalse(is_source_checkout(tempfile.mkdtemp()))

    def test_guard_blocks_without_override(self) -> None:
        d = self._make_source()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(UsageError) as ctx:
                ensure_source_run_allowed(d, "run issue #1")
            self.assertEqual(ctx.exception.code, 1)

    def test_guard_allows_with_override(self) -> None:
        d = self._make_source()
        with patch.dict(os.environ, {"AGENTRAIL_ALLOW_SOURCE_RUN": "1"}, clear=True):
            ensure_source_run_allowed(d, "run issue #1")  # no raise
