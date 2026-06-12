"""Tests for per-agent model selection (issue #512).

Covers:
- AC1: --model flag on `run issue` appends model to agent command
- AC2: config runners.<engine>.models[phase] gives per-phase model
- AC3: explicit --command is never mutated
- Both engines (claude / codex)
- No-model passthrough (command unchanged)
- Flag precedence: --model > models[phase] > model > none
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.run import (
    RunOptions,
    append_model_to_command,
    exec_issue,
    parse_batch_args,
    parse_run_options,
    resolve_model_for_phase,
    resolve_model_from_config,
)


# ---------------------------------------------------------------------------
# append_model_to_command
# ---------------------------------------------------------------------------

class AppendModelToCommandTests(unittest.TestCase):
    def test_claude_appends_model_flag(self) -> None:
        result = append_model_to_command(
            "claude -p --dangerously-skip-permissions", "claude", "claude-fable-5"
        )
        self.assertEqual(
            result, "claude -p --dangerously-skip-permissions --model claude-fable-5"
        )

    def test_codex_appends_m_flag(self) -> None:
        result = append_model_to_command(
            "codex exec --sandbox danger-full-access -", "codex", "o3"
        )
        self.assertEqual(
            result, "codex exec --sandbox danger-full-access - -m o3"
        )

    def test_no_model_returns_command_unchanged(self) -> None:
        cmd = "claude -p --dangerously-skip-permissions"
        self.assertEqual(append_model_to_command(cmd, "claude", ""), cmd)

    def test_no_model_codex_returns_command_unchanged(self) -> None:
        cmd = "codex exec --sandbox danger-full-access -"
        self.assertEqual(append_model_to_command(cmd, "codex", ""), cmd)


# ---------------------------------------------------------------------------
# resolve_model_from_config
# ---------------------------------------------------------------------------

class ResolveModelFromConfigTests(unittest.TestCase):
    def _make_target(self, runners_cfg: dict) -> str:
        d = tempfile.mkdtemp()
        agentrail_dir = Path(d) / ".agentrail"
        agentrail_dir.mkdir()
        (agentrail_dir / "config.json").write_text(
            json.dumps({"runners": runners_cfg})
        )
        return d

    def test_flat_model_returned(self) -> None:
        target = self._make_target({"claude": {"model": "claude-opus-4-8"}})
        self.assertEqual(
            resolve_model_from_config("claude", target), "claude-opus-4-8"
        )

    def test_phase_model_wins_over_flat(self) -> None:
        target = self._make_target({
            "claude": {
                "model": "claude-sonnet-4-6",
                "models": {"execute": "claude-fable-5"},
            }
        })
        self.assertEqual(
            resolve_model_from_config("claude", target, "execute"), "claude-fable-5"
        )

    def test_flat_model_used_when_phase_not_in_map(self) -> None:
        target = self._make_target({
            "claude": {
                "model": "claude-sonnet-4-6",
                "models": {"execute": "claude-fable-5"},
            }
        })
        self.assertEqual(
            resolve_model_from_config("claude", target, "plan"), "claude-sonnet-4-6"
        )

    def test_no_config_returns_empty(self) -> None:
        d = tempfile.mkdtemp()
        self.assertEqual(resolve_model_from_config("claude", d), "")

    def test_missing_agent_returns_empty(self) -> None:
        target = self._make_target({"codex": {"model": "o3"}})
        self.assertEqual(resolve_model_from_config("claude", target), "")


# ---------------------------------------------------------------------------
# resolve_model_for_phase
# ---------------------------------------------------------------------------

class ResolveModelForPhaseTests(unittest.TestCase):
    def _make_target(self, runners_cfg: dict) -> str:
        d = tempfile.mkdtemp()
        agentrail_dir = Path(d) / ".agentrail"
        agentrail_dir.mkdir()
        (agentrail_dir / "config.json").write_text(
            json.dumps({"runners": runners_cfg})
        )
        return d

    def test_flag_wins_over_config(self) -> None:
        target = self._make_target({"claude": {"model": "claude-sonnet-4-6"}})
        self.assertEqual(
            resolve_model_for_phase("claude", "claude-fable-5", target, "execute"),
            "claude-fable-5",
        )

    def test_flag_wins_over_phase_map(self) -> None:
        target = self._make_target({
            "claude": {"models": {"execute": "claude-opus-4-8"}}
        })
        self.assertEqual(
            resolve_model_for_phase("claude", "claude-fable-5", target, "execute"),
            "claude-fable-5",
        )

    def test_phase_map_used_when_no_flag(self) -> None:
        target = self._make_target({
            "claude": {"models": {"execute": "claude-fable-5"}}
        })
        self.assertEqual(
            resolve_model_for_phase("claude", "", target, "execute"), "claude-fable-5"
        )

    def test_flat_model_used_when_no_flag_no_phase_map(self) -> None:
        target = self._make_target({"claude": {"model": "claude-haiku-4-5"}})
        self.assertEqual(
            resolve_model_for_phase("claude", "", target, "plan"), "claude-haiku-4-5"
        )

    def test_no_model_anywhere_returns_empty(self) -> None:
        d = tempfile.mkdtemp()
        self.assertEqual(resolve_model_for_phase("claude", "", d, "execute"), "")


# ---------------------------------------------------------------------------
# AC1: --model flag produces agent command with model appended
# ---------------------------------------------------------------------------

class ModelFlagOnRunIssueTests(unittest.TestCase):
    """AC1: run issue N --agent claude --model claude-fable-5 → command has --model."""

    def test_model_flag_appended_to_claude_command(self) -> None:
        captured: list[dict] = []

        def fake_run_issue(target_dir, issue, *, agent, command, repo_dir,
                           log_dir=None, run_id="", phase_commands=None):
            captured.append({"phase_commands": phase_commands or {}})
            return 0

        with patch("agentrail.run.pipeline.run_issue", side_effect=fake_run_issue), \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")):
            with tempfile.TemporaryDirectory() as td:
                opts = RunOptions(
                    agent="claude",
                    target=td,
                    command="claude -p --dangerously-skip-permissions",
                    model="claude-fable-5",
                    command_explicit=False,
                )
                exec_issue(1, opts)

        self.assertEqual(len(captured), 1)
        phase_commands = captured[0]["phase_commands"]
        self.assertIn("execute", phase_commands)
        self.assertIn("--model claude-fable-5", phase_commands["execute"])
        self.assertIn("plan", phase_commands)
        self.assertIn("--model claude-fable-5", phase_commands["plan"])

    def test_model_flag_appended_to_codex_command(self) -> None:
        captured: list[dict] = []

        def fake_run_issue(target_dir, issue, *, agent, command, repo_dir,
                           log_dir=None, run_id="", phase_commands=None):
            captured.append({"phase_commands": phase_commands or {}})
            return 0

        with patch("agentrail.run.pipeline.run_issue", side_effect=fake_run_issue), \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")):
            with tempfile.TemporaryDirectory() as td:
                opts = RunOptions(
                    agent="codex",
                    target=td,
                    command="codex exec --sandbox danger-full-access -",
                    model="o3",
                    command_explicit=False,
                )
                exec_issue(1, opts)

        phase_commands = captured[0]["phase_commands"]
        self.assertIn("-m o3", phase_commands["execute"])
        self.assertIn("-m o3", phase_commands["plan"])


# ---------------------------------------------------------------------------
# AC2: per-phase config → only that phase carries model
# ---------------------------------------------------------------------------

class PerPhaseConfigTests(unittest.TestCase):
    """AC2: config models: {execute: claude-fable-5} → only execute phase has model."""

    def test_only_execute_phase_gets_model(self) -> None:
        captured: list[dict] = []

        def fake_run_issue(target_dir, issue, *, agent, command, repo_dir,
                           log_dir=None, run_id="", phase_commands=None):
            captured.append({"command": command, "phase_commands": phase_commands or {}})
            return 0

        with patch("agentrail.run.pipeline.run_issue", side_effect=fake_run_issue), \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")):
            with tempfile.TemporaryDirectory() as td:
                agentrail_dir = Path(td) / ".agentrail"
                agentrail_dir.mkdir()
                (agentrail_dir / "config.json").write_text(json.dumps({
                    "runners": {
                        "claude": {
                            "models": {"execute": "claude-fable-5"},
                        }
                    }
                }))
                opts = RunOptions(
                    agent="claude",
                    target=td,
                    command="claude -p --dangerously-skip-permissions",
                    model="",
                    command_explicit=False,
                )
                exec_issue(1, opts)

        phase_commands = captured[0]["phase_commands"]
        # execute phase has model
        self.assertIn("execute", phase_commands)
        self.assertIn("--model claude-fable-5", phase_commands["execute"])
        # plan phase does NOT have a model override
        self.assertNotIn("plan", phase_commands)


# ---------------------------------------------------------------------------
# AC3: explicit --command is never mutated
# ---------------------------------------------------------------------------

class ExplicitCommandNotMutatedTests(unittest.TestCase):
    """AC3: when --command was explicitly passed, phase_commands is empty."""

    def test_explicit_command_not_mutated(self) -> None:
        captured: list[dict] = []

        def fake_run_issue(target_dir, issue, *, agent, command, repo_dir,
                           log_dir=None, run_id="", phase_commands=None):
            captured.append({"command": command, "phase_commands": phase_commands or {}})
            return 0

        with patch("agentrail.run.pipeline.run_issue", side_effect=fake_run_issue), \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")):
            with tempfile.TemporaryDirectory() as td:
                agentrail_dir = Path(td) / ".agentrail"
                agentrail_dir.mkdir()
                (agentrail_dir / "config.json").write_text(json.dumps({
                    "runners": {"claude": {"model": "claude-fable-5"}}
                }))
                opts = RunOptions(
                    agent="claude",
                    target=td,
                    command="my-custom-agent --flag",
                    model="claude-fable-5",
                    command_explicit=True,
                )
                exec_issue(1, opts)

        phase_commands = captured[0]["phase_commands"]
        self.assertEqual(phase_commands, {})
        self.assertEqual(captured[0]["command"], "my-custom-agent --flag")


# ---------------------------------------------------------------------------
# No-model passthrough
# ---------------------------------------------------------------------------

class NoModelPassthroughTests(unittest.TestCase):
    def test_no_model_no_phase_commands(self) -> None:
        captured: list[dict] = []

        def fake_run_issue(target_dir, issue, *, agent, command, repo_dir,
                           log_dir=None, run_id="", phase_commands=None):
            captured.append({"phase_commands": phase_commands or {}})
            return 0

        with patch("agentrail.run.pipeline.run_issue", side_effect=fake_run_issue), \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")):
            with tempfile.TemporaryDirectory() as td:
                opts = RunOptions(
                    agent="claude",
                    target=td,
                    command="claude -p --dangerously-skip-permissions",
                    model="",
                    command_explicit=False,
                )
                exec_issue(1, opts)

        self.assertEqual(captured[0]["phase_commands"], {})


# ---------------------------------------------------------------------------
# parse_run_options --model flag
# ---------------------------------------------------------------------------

class ParseRunOptionsModelTests(unittest.TestCase):
    def test_model_flag_parsed(self) -> None:
        opts = parse_run_options(["--model", "claude-fable-5"])
        self.assertEqual(opts.model, "claude-fable-5")

    def test_command_sets_command_explicit(self) -> None:
        opts = parse_run_options(["--command", "my-agent"])
        self.assertTrue(opts.command_explicit)
        self.assertEqual(opts.command, "my-agent")

    def test_no_command_explicit_false(self) -> None:
        opts = parse_run_options([])
        self.assertFalse(opts.command_explicit)


# ---------------------------------------------------------------------------
# parse_batch_args --model flag
# ---------------------------------------------------------------------------

class ParseBatchArgsModelTests(unittest.TestCase):
    def test_model_flag_parsed(self) -> None:
        cfg = parse_batch_args(["--model", "claude-fable-5", "42"])
        self.assertEqual(cfg.model, "claude-fable-5")

    def test_model_default_empty(self) -> None:
        cfg = parse_batch_args(["42"])
        self.assertEqual(cfg.model, "")


if __name__ == "__main__":
    unittest.main()
