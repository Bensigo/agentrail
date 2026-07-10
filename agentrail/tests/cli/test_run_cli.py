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
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.run import (
    run_run, AGENTS, DEFAULT_COMMANDS, parse_run_options, UsageError,
    resolve_agent_name, resolve_agent_command,
    is_source_checkout, ensure_source_run_allowed,
    active_run_issue, ensure_no_conflicting_active_run,
    next_pickable_issue,
    exec_issue, exec_prompt, RunOptions,
    parse_batch_args, run_batch,
    ensure_command_available,
)


class EnsureCommandAvailableTests(unittest.TestCase):
    """Ported from the deleted bash scripts/test-runner-adapter:
    the runner must reject an empty custom command and a command whose
    binary is not on PATH."""

    def test_empty_command_rejected(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            ensure_command_available("")
        self.assertIn("runner command is empty", str(ctx.exception))

    def test_whitespace_only_command_rejected(self) -> None:
        with self.assertRaises(UsageError) as ctx:
            ensure_command_available("   ")
        self.assertIn("runner command is empty", str(ctx.exception))

    def test_missing_binary_rejected(self) -> None:
        with patch("shutil.which", return_value=None):
            with self.assertRaises(UsageError) as ctx:
                ensure_command_available("definitely-not-agentrail-runner")
        self.assertIn(
            "missing required command: definitely-not-agentrail-runner",
            str(ctx.exception),
        )

    def test_present_binary_accepted(self) -> None:
        with patch("shutil.which", return_value="/usr/bin/cat"):
            # uses only the first token as the binary to resolve
            ensure_command_available("cat --some-flag value")


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
        (p / "agentrail" / "templates" / "scripts").mkdir(parents=True)
        (p / "agentrail" / "scripts").mkdir()
        exe = p / "agentrail" / "scripts" / "agentrail"
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


class ActiveRunTests(unittest.TestCase):
    def _state(self, data: dict) -> str:
        d = tempfile.mkdtemp()
        (Path(d) / ".agentrail").mkdir()
        (Path(d) / ".agentrail" / "state.json").write_text(json.dumps(data))
        return d

    def test_no_state_file_returns_none(self) -> None:
        self.assertIsNone(active_run_issue(tempfile.mkdtemp()))

    def test_no_active_run_returns_none(self) -> None:
        d = self._state({"workflow": {}})
        self.assertIsNone(active_run_issue(d))

    def test_active_run_issue_from_target_issue(self) -> None:
        d = self._state({"workflow": {"activeRun": {"targetIssue": 42}}})
        self.assertEqual(active_run_issue(d), "42")

    def test_conflict_same_issue_raises(self) -> None:
        d = self._state({"workflow": {"activeRun": {"targetIssue": 7}}})
        with patch("builtins.print"):
            with self.assertRaises(UsageError):
                ensure_no_conflicting_active_run(d, "7")

    def test_no_conflict_when_no_active(self) -> None:
        d = self._state({"workflow": {}})
        ensure_no_conflicting_active_run(d, "7")  # no raise


class NextPickableTests(unittest.TestCase):
    def test_picks_lowest_number(self) -> None:
        payload = json.dumps([
            {"number": 9, "title": "b", "url": "u9"},
            {"number": 4, "title": "a", "url": "u4"},
        ])
        cp = MagicMock(returncode=0, stdout=payload)
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp):
            picked = next_pickable_issue("/tmp/x")
        self.assertEqual(picked, (4, "a", "u4"))

    def test_empty_returns_none(self) -> None:
        cp = MagicMock(returncode=0, stdout="[]")
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp):
            self.assertIsNone(next_pickable_issue("/tmp/x"))

    def test_gh_failure_returns_none(self) -> None:
        cp = MagicMock(returncode=1, stdout="")
        with patch("agentrail.cli.commands.run.subprocess.run", return_value=cp):
            self.assertIsNone(next_pickable_issue("/tmp/x"))


class ExecIssueTests(unittest.TestCase):
    """Tests for exec_issue — always-native pipeline."""

    def _patch_native(self, return_value=0):
        """Return a stack of patches for the native pipeline."""
        return [
            patch("agentrail.run.pipeline.run_issue", return_value=return_value),
            patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")),
            patch("agentrail.cli.commands.run.resolve_agent_command", return_value="claude -p"),
            patch("agentrail.cli.commands.run.resolve_agent_name", return_value="claude"),
        ]

    def test_native_default_calls_run_issue(self) -> None:
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p", log_dir="")
        patches = self._patch_native()
        with patches[0] as mock_run_issue, patches[1], patches[2], patches[3]:
            rc = exec_issue(7, opts)
        self.assertEqual(rc, 0)
        mock_run_issue.assert_called_once()
        call_kwargs = mock_run_issue.call_args
        self.assertEqual(call_kwargs.args[1], 7)
        self.assertEqual(call_kwargs.kwargs["agent"], "claude")
        self.assertEqual(call_kwargs.kwargs["command"], "claude -p")
        self.assertEqual(call_kwargs.kwargs["repo_dir"], Path("/repo"))

    def test_log_dir_empty_passes_none(self) -> None:
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p", log_dir="")
        patches = self._patch_native()
        with patches[0] as mock_run_issue, patches[1], patches[2], patches[3]:
            exec_issue(7, opts)
        self.assertIsNone(mock_run_issue.call_args.kwargs["log_dir"])

    def test_log_dir_set_passes_path(self) -> None:
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p", log_dir="/tmp/logs")
        patches = self._patch_native()
        with patches[0] as mock_run_issue, patches[1], patches[2], patches[3]:
            exec_issue(7, opts)
        self.assertEqual(mock_run_issue.call_args.kwargs["log_dir"], Path("/tmp/logs"))

    def test_env_zero_still_calls_run_issue(self) -> None:
        """Regression: AGENTRAIL_NATIVE_RUN=0 escape hatch is gone; native always runs."""
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p", log_dir="")
        patches = self._patch_native()
        with patches[0] as mock_run_issue, patches[1], patches[2], patches[3], \
             patch.dict(os.environ, {"AGENTRAIL_NATIVE_RUN": "0"}, clear=False):
            rc = exec_issue(11, opts)
        mock_run_issue.assert_called_once()
        self.assertEqual(rc, 0)


class VerifyGateLayerCommandTests(unittest.TestCase):
    """VERIFY_GATE eval toggle at the CLI seam: exec_issue builds a distinct-model
    verify command by default, and OMITS it when the layer is OFF — so no verify
    phase runs. Absent flag = ON = today's behavior (the real loop sets none of
    these env vars)."""

    def _config_with_distinct_models(self) -> str:
        tmp = tempfile.mkdtemp()
        target = Path(tmp) / "target"
        (target / ".agentrail").mkdir(parents=True)
        (target / ".agentrail" / "config.json").write_text(json.dumps({
            "runners": {
                "claude": {
                    "command": "claude -p",
                    "models": {"execute": "model-a", "verify": "model-b"},
                }
            }
        }))
        return str(target)

    def _exec_issue_capture_phase_commands(self, env):
        target = self._config_with_distinct_models()
        opts = RunOptions(agent="claude", target=target, command="", log_dir="")
        clean = {k: v for k, v in os.environ.items()
                 if not k.startswith("AGENTRAIL_EVAL_LAYER_")}
        clean.update(env)
        with patch("agentrail.run.pipeline.run_issue", return_value=0) as mock_run_issue, \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")), \
             patch.dict(os.environ, clean, clear=True):
            exec_issue(7, opts)
        return mock_run_issue.call_args.kwargs["phase_commands"]

    def test_verify_gate_on_default_builds_verify_command(self) -> None:
        pc = self._exec_issue_capture_phase_commands(env={})
        self.assertIn("verify", pc)
        self.assertIn("model-b", pc["verify"])

    def test_verify_gate_off_omits_verify_command(self) -> None:
        pc = self._exec_issue_capture_phase_commands(
            env={"AGENTRAIL_EVAL_LAYER_VERIFY_GATE": "0"})
        self.assertNotIn("verify", pc)
        # The implementer model overrides are still built (only verify is gated).
        self.assertIn("execute", pc)


class CriticLayerCommandTests(unittest.TestCase):
    """CRITIC eval toggle at the CLI seam (#977): exec_issue builds a CHEAP-model
    ``critic`` command ONLY when explicitly opted in via ``models.critic`` config,
    and OMITS it when the layer is OFF. The real loop (no ``models.critic``) builds
    no critic command, so the verify path is unchanged."""

    def _config(self, *, critic=True) -> str:
        tmp = tempfile.mkdtemp()
        target = Path(tmp) / "target"
        (target / ".agentrail").mkdir(parents=True)
        models = {"execute": "model-a", "verify": "model-b"}
        if critic:
            models["critic"] = "claude-haiku-4-5-20251001"
        (target / ".agentrail" / "config.json").write_text(json.dumps({
            "runners": {"claude": {"command": "claude -p", "models": models}}
        }))
        return str(target)

    def _capture_phase_commands(self, target, env):
        opts = RunOptions(agent="claude", target=target, command="", log_dir="")
        clean = {k: v for k, v in os.environ.items()
                 if not k.startswith("AGENTRAIL_EVAL_LAYER_")}
        clean.update(env)
        with patch("agentrail.run.pipeline.run_issue", return_value=0) as mock_run_issue, \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")), \
             patch.dict(os.environ, clean, clear=True):
            exec_issue(7, opts)
        return mock_run_issue.call_args.kwargs["phase_commands"]

    def test_critic_command_built_when_configured(self) -> None:
        pc = self._capture_phase_commands(self._config(critic=True), env={})
        self.assertIn("critic", pc)
        self.assertIn("haiku", pc["critic"])

    def test_critic_command_omitted_when_layer_off(self) -> None:
        pc = self._capture_phase_commands(
            self._config(critic=True),
            env={"AGENTRAIL_EVAL_LAYER_CRITIC": "0"})
        self.assertNotIn("critic", pc)
        # verify is still built (only the critic is gated out).
        self.assertIn("verify", pc)

    def test_no_critic_command_without_config(self) -> None:
        # Real loop: no models.critic -> no critic command -> verify path unchanged.
        pc = self._capture_phase_commands(self._config(critic=False), env={})
        self.assertNotIn("critic", pc)
        self.assertIn("verify", pc)

    def _capture_phase_commands_with_model(self, target, env, model):
        # Same as _capture_phase_commands but with the IMPLEMENTER --model flag set
        # (RunOptions.model), which is exactly what the eval's new-flow arm does.
        opts = RunOptions(agent="claude", target=target, command="", log_dir="", model=model)
        clean = {k: v for k, v in os.environ.items()
                 if not k.startswith("AGENTRAIL_EVAL_LAYER_")}
        clean.update(env)
        with patch("agentrail.run.pipeline.run_issue", return_value=0) as mock_run_issue, \
             patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")), \
             patch.dict(os.environ, clean, clear=True):
            exec_issue(7, opts)
        return mock_run_issue.call_args.kwargs["phase_commands"]

    def test_critic_built_when_implementer_model_flag_is_set(self) -> None:
        # Regression: when the implementer --model flag is set (the eval new-flow
        # arm pins the implementer model), the critic must STILL resolve to its OWN
        # configured cheap model — NOT inherit the implementer's flag, trip the
        # independence guard, and silently collapse to "" (which let verify run
        # instead, so new-flow behaved identically to full in a live run).
        pc = self._capture_phase_commands_with_model(
            self._config(critic=True), env={}, model="claude-sonnet-4-5"
        )
        self.assertIn("critic", pc)
        self.assertIn("haiku", pc["critic"])
        # And the critic is on a DIFFERENT model than the implementer flag.
        self.assertNotIn("claude-sonnet-4-5", pc["critic"])


class ExecPromptTests(unittest.TestCase):
    """#968: exec_prompt delegates to pipeline.run_prompt with the prompt text."""

    def _patches(self):
        return [
            patch("agentrail.run.pipeline.run_prompt", return_value=0),
            patch("agentrail.cli.commands.run._repo_dir", return_value=Path("/repo")),
            patch("agentrail.cli.commands.run.resolve_agent_command", return_value="claude -p"),
            patch("agentrail.cli.commands.run.resolve_agent_name", return_value="claude"),
        ]

    def test_calls_run_prompt_with_prompt_and_label(self) -> None:
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p",
                          label="afk-objective-gate")
        p = self._patches()
        with p[0] as mock_run_prompt, p[1], p[2], p[3]:
            rc = exec_prompt("Realign the gate to ADR 0007.", opts)
        self.assertEqual(rc, 0)
        mock_run_prompt.assert_called_once()
        ca = mock_run_prompt.call_args
        # prompt is the 2nd positional arg.
        self.assertEqual(ca.args[1], "Realign the gate to ADR 0007.")
        self.assertEqual(ca.kwargs["label"], "afk-objective-gate")
        self.assertEqual(ca.kwargs["repo_dir"], Path("/repo"))

    def test_default_label_is_prompt(self) -> None:
        opts = RunOptions(agent="claude", target="/tmp/x", command="claude -p")
        p = self._patches()
        with p[0] as mock_run_prompt, p[1], p[2], p[3]:
            exec_prompt("do the thing", opts)
        self.assertEqual(mock_run_prompt.call_args.kwargs["label"], "prompt")


class ParseBatchTests(unittest.TestCase):
    def test_positional_issues_and_defaults(self) -> None:
        cfg = parse_batch_args(["360", "361"])
        self.assertEqual(cfg.issues, [360, 361])
        self.assertEqual(cfg.concurrency, 2)
        self.assertEqual(cfg.base, "main")

    def test_double_dash_issue_list(self) -> None:
        cfg = parse_batch_args(["--concurrency", "3", "--", "5", "6", "7"])
        self.assertEqual(cfg.concurrency, 3)
        self.assertEqual(cfg.issues, [5, 6, 7])

    def test_requires_at_least_one_issue(self) -> None:
        with self.assertRaises(UsageError):
            parse_batch_args(["--concurrency", "2"])

    def test_rejects_non_positive_concurrency(self) -> None:
        with self.assertRaises(UsageError):
            parse_batch_args(["--concurrency", "0", "5"])

    def test_first_issue_not_dropped(self) -> None:
        # regression: the legacy bash double-shift dropped the first issue
        cfg = parse_batch_args(["360", "361"])
        self.assertIn(360, cfg.issues)

    def test_rejects_non_integer_concurrency(self) -> None:
        with self.assertRaises(UsageError):
            parse_batch_args(["--concurrency", "abc", "5"])

    def test_rejects_bad_agent(self) -> None:
        with self.assertRaises(UsageError):
            parse_batch_args(["--agent", "bogus", "5"])


class RunBatchExecTests(unittest.TestCase):
    def test_runs_each_issue_once(self) -> None:
        calls = []
        def fake_exec(issue, opts, allow_source=False):
            calls.append(issue); return 0
        with patch("agentrail.cli.commands.run.exec_issue", side_effect=fake_exec), \
             patch("agentrail.cli.commands.run._git_worktree_add"), \
             patch("agentrail.cli.commands.run._git_worktree_remove"), \
             patch("agentrail.cli.commands.run._git_fetch"), \
             patch("agentrail.cli.commands.run._seed_agentrail"), \
             patch("agentrail.cli.commands.run.ensure_source_run_allowed"), \
             patch("agentrail.cli.commands.run.ensure_command_available"):
            rc = run_batch(["--target", "/tmp/x", "360", "361"])
        self.assertEqual(rc, 0)
        self.assertEqual(sorted(calls), [360, 361])


class DispatchTests(unittest.TestCase):
    def test_issue_subcommand_routes_to_exec(self) -> None:
        with patch("agentrail.cli.commands.run.exec_issue", return_value=0) as m, \
             patch("agentrail.cli.commands.run.ensure_source_run_allowed"), \
             patch("agentrail.cli.commands.run.ensure_no_conflicting_active_run"), \
             patch("agentrail.cli.commands.run.resolve_agent_command", return_value="claude -p"), \
             patch("agentrail.cli.commands.run.ensure_command_available"):
            rc = run_run(["issue", "42", "--agent", "claude", "--target", "/tmp/x"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], 42)

    def test_issue_requires_number(self) -> None:
        rc = run_run(["issue", "--agent", "claude"])
        self.assertEqual(rc, 2)

    def test_prompt_subcommand_routes_to_exec_prompt(self) -> None:
        with patch("agentrail.cli.commands.run.exec_prompt", return_value=0) as m, \
             patch("agentrail.cli.commands.run.ensure_source_run_allowed"), \
             patch("agentrail.cli.commands.run.resolve_agent_command", return_value="claude -p"), \
             patch("agentrail.cli.commands.run.ensure_command_available"):
            rc = run_run(["prompt", "Fix the gate", "--agent", "claude",
                          "--target", "/tmp/x", "--label", "task-1"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], "Fix the gate")

    def test_prompt_missing_text_returns_2(self) -> None:
        rc = run_run(["prompt", "--agent", "claude"])
        self.assertEqual(rc, 2)

    def test_batch_subcommand_routes(self) -> None:
        with patch("agentrail.cli.commands.run.run_batch", return_value=0) as m:
            rc = run_run(["batch", "1", "2"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], ["1", "2"])

    def test_main_routes_run(self) -> None:
        from agentrail.cli import main as main_mod
        with patch.object(main_mod, "run_run", return_value=0) as m:
            rc = main_mod.main(["run", "issue", "5"])
        self.assertEqual(rc, 0)
        self.assertEqual(m.call_args.args[0], ["issue", "5"])
