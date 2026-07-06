"""Pipeline + CLI wiring for the JIT context-gatherer seam (issue #1049, PR B).

The gather phase is a cheap-model, read-only context gatherer that runs BEFORE
test-author, behind the DEFAULT-OFF ``AGENTRAIL_JIT_GATHER`` flag. These tests
pin the seam's two critical properties:

- **No-fallback (AC2)**: the pipeline's generic phase-command lookup is
  ``rc.phase_commands.get(phase, rc.agent_command)`` — a fallback to the
  IMPLEMENTER's command. Gather must never reach that fallback: when no gather
  command was enumerated, the phase is SKIPPED ENTIRELY (even with the flag ON),
  and when one was enumerated, the phase runs on it. Presence in
  ``phase_commands`` is the only way gather runs.
- **Flag-OFF neutrality**: with ``AGENTRAIL_JIT_GATHER`` unset (or ``"0"``),
  no gather command is enumerated at the CLI layer and the pipeline never runs
  a gather phase — the phase sequence is byte-identical to today's.

Gather is ADVISORY: a failing gather phase is logged and the run continues.
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
    _phase_commands_for,
    resolve_gather_command,
)
from agentrail.run.critic import (
    CRITIC_DEFAULT_MODEL,
    GATHER_DEFAULT_MODEL,
    resolve_gather_model,
)
from agentrail.run.pipeline import jit_gather_enabled, run_issue

ACCEPT = 'VERDICT: {"verdict":"accept","reason":"ok"}'


def _make_target(tmp_dir: str, config: dict | None = None) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    cfg = {"verify": f"test -f {target / 'impl_done'}"}
    cfg.update(config or {})
    (agentrail_dir / "config.json").write_text(json.dumps(cfg))
    return target


def _sentinel(target: Path) -> Path:
    return target / "impl_done"


def _clean_env(**overrides):
    # Strip ablation layers AND the gather flag/env so each test states its own
    # gather environment explicitly (the flag must default OFF, so a leaked
    # AGENTRAIL_JIT_GATHER from the outer shell would invalidate the tests).
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")
           and k not in ("AGENTRAIL_JIT_GATHER", "AGENTRAIL_EVAL_GATHER_MODEL")}
    env["AGENTRAIL_EVAL_LAYER_BESTOFN"] = "0"
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


def _run_issue_with_phase_stub(target, repo, phase_stub, phase_commands=None, env=None):
    captured = {"phases": []}

    def _wrapped(rc, phase, attempt, verifier_findings_file="", plan_output=""):
        captured["phases"].append(phase)
        return phase_stub(rc, phase, attempt, verifier_findings_file, plan_output)

    gh_mock = MagicMock()
    gh_mock.returncode = 1
    gh_mock.stdout = ""

    with _clean_env(**(env or {})), \
         patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
         patch("agentrail.run.pipeline.skills.resolve_skills",
               return_value={"resolved": [], "autoSkills": True}), \
         patch("agentrail.run.pipeline.ctx.build_issue_context_pack", return_value="pack.json"), \
         patch("agentrail.run.pipeline.ctx.context_pack_summary", return_value="SUMMARY"), \
         patch("agentrail.run.pipeline.ctx.context_selected_snippets", return_value="SNIPPETS"), \
         patch("agentrail.run.pipeline.ctx.context_retrieval_metadata", return_value={}), \
         patch("agentrail.run.pipeline.state_mod.render_state_summary", return_value=""), \
         patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
         patch("agentrail.run.pipeline.prompts.format_skill_resolution", return_value=""), \
         patch("agentrail.run.pipeline.prompts.issue_base_prompt", return_value="BP"), \
         patch("agentrail.run.pipeline.run_issue_phase", side_effect=_wrapped), \
         patch("agentrail.run.pipeline.state_mod.update_run_state"), \
         patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
         patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
        result = run_issue(target, 7, agent="claude", command="c", repo_dir=repo,
                           phase_commands=phase_commands)
    return result, captured


class JitGatherFlagTests(unittest.TestCase):
    """The flag helper defaults OFF and only "1" turns it on."""

    def test_default_off_when_unset(self):
        with _clean_env():
            self.assertFalse(jit_gather_enabled())

    def test_off_when_zero(self):
        with _clean_env(AGENTRAIL_JIT_GATHER="0"):
            self.assertFalse(jit_gather_enabled())

    def test_on_when_one(self):
        with _clean_env(AGENTRAIL_JIT_GATHER="1"):
            self.assertTrue(jit_gather_enabled())

    def test_on_when_one_with_whitespace(self):
        with _clean_env(AGENTRAIL_JIT_GATHER=" 1 "):
            self.assertTrue(jit_gather_enabled())


class ResolveGatherModelTests(unittest.TestCase):
    def test_blank_falls_back_to_cheap_default(self):
        self.assertEqual(resolve_gather_model(""), GATHER_DEFAULT_MODEL)
        self.assertEqual(resolve_gather_model(None), GATHER_DEFAULT_MODEL)

    def test_configured_model_wins(self):
        self.assertEqual(resolve_gather_model("claude-haiku-x"), "claude-haiku-x")

    def test_default_is_the_cheap_critic_tier(self):
        # The gather default is the same fast, cheap tier as the critic (Haiku).
        self.assertEqual(GATHER_DEFAULT_MODEL, CRITIC_DEFAULT_MODEL)


class ResolveGatherCommandTests(unittest.TestCase):
    """The gather command is opt-in-only and never the implementer's model."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def test_not_opted_in_returns_empty(self):
        # The real loop: no models.gather config and no eval env var → "".
        target = _make_target(self.tmp)
        with _clean_env():
            self.assertEqual(
                resolve_gather_command("claude", "claude -p", "", str(target)), "")

    def test_config_opt_in_appends_gather_model(self):
        target = _make_target(self.tmp, {
            "runners": {"claude": {"models": {"gather": "claude-haiku-4-5",
                                              "execute": "claude-opus-4"}}},
        })
        with _clean_env():
            cmd = resolve_gather_command("claude", "claude -p", "", str(target))
        self.assertEqual(cmd, "claude -p --model claude-haiku-4-5")

    def test_env_opt_in_appends_gather_model(self):
        # Eval harness opt-in: env var, no config written into the task repo.
        target = _make_target(self.tmp)
        with _clean_env(AGENTRAIL_EVAL_GATHER_MODEL="claude-haiku-4-5"):
            cmd = resolve_gather_command("claude", "claude -p", "", str(target))
        self.assertEqual(cmd, "claude -p --model claude-haiku-4-5")

    def test_never_sources_model_from_model_flag(self):
        # CRITICAL regression guard (the critic once had this bug): the
        # implementer's --model flag must NOT opt the gatherer in. Not opted in
        # via its OWN sources → "" even when model_flag is set.
        target = _make_target(self.tmp)
        with _clean_env():
            self.assertEqual(
                resolve_gather_command(
                    "claude", "claude -p", "claude-opus-4", str(target)), "")

    def test_gather_model_equal_to_implementer_model_returns_empty(self):
        # Independence guard: a gather model identical to the implementer's
        # execute model defeats the cheap-model point → no gather command.
        target = _make_target(self.tmp, {
            "runners": {"claude": {"models": {"gather": "claude-opus-4",
                                              "execute": "claude-opus-4"}}},
        })
        with _clean_env():
            self.assertEqual(
                resolve_gather_command("claude", "claude -p", "", str(target)), "")

    def test_model_flag_as_implementer_trips_independence_guard(self):
        # model_flag IS the implementer's model for the independence check:
        # gather opted in to the same model the flag pins execute to → "".
        target = _make_target(self.tmp)
        with _clean_env(AGENTRAIL_EVAL_GATHER_MODEL="claude-haiku-4-5"):
            self.assertEqual(
                resolve_gather_command(
                    "claude", "claude -p", "claude-haiku-4-5", str(target)), "")

    def test_codex_uses_short_model_flag(self):
        target = _make_target(self.tmp)
        with _clean_env(AGENTRAIL_EVAL_GATHER_MODEL="gpt-5-mini"):
            cmd = resolve_gather_command("codex", "codex exec -", "", str(target))
        self.assertEqual(cmd, "codex exec - -m gpt-5-mini")


class PhaseCommandsEnumerationTests(unittest.TestCase):
    """CLI-layer enumeration: gather appears ONLY with flag ON + opt-in."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name, {
            "runners": {"claude": {"models": {"gather": "claude-haiku-4-5"}}},
        })
        self.opts = RunOptions(target=str(self.target))

    def tearDown(self):
        self._tmp.cleanup()

    def _commands(self):
        return _phase_commands_for(self.opts, "claude", "claude -p", self.target)

    def test_flag_unset_enumerates_no_gather(self):
        # Flag-OFF neutrality: even with a gather model configured, no gather
        # entry is built and the phase set is unchanged.
        with _clean_env():
            self.assertNotIn("gather", self._commands())

    def test_flag_zero_enumerates_no_gather(self):
        with _clean_env(AGENTRAIL_JIT_GATHER="0"):
            self.assertNotIn("gather", self._commands())

    def test_flag_on_with_opt_in_enumerates_gather(self):
        with _clean_env(AGENTRAIL_JIT_GATHER="1"):
            commands = self._commands()
        self.assertEqual(commands.get("gather"), "claude -p --model claude-haiku-4-5")

    def test_flag_on_without_opt_in_enumerates_no_gather(self):
        target = _make_target(self._tmp.name + "/plain")
        opts = RunOptions(target=str(target))
        with _clean_env(AGENTRAIL_JIT_GATHER="1"):
            commands = _phase_commands_for(opts, "claude", "claude -p", target)
        self.assertNotIn("gather", commands)

    def test_command_explicit_enumerates_nothing(self):
        # --command is user-owned: never mutated, no per-phase overrides at all.
        self.opts.command_explicit = True
        with _clean_env(AGENTRAIL_JIT_GATHER="1"):
            self.assertEqual(self._commands(), {})


class GatherPipelineTests(unittest.TestCase):
    """Pipeline seam: presence in phase_commands + flag ON is the ONLY way
    gather runs — it never falls back to the implementer command (AC2)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, gather_status=0):
        def _p(rc, phase, attempt, vff, plan_output):
            if phase == "gather":
                return (gather_status, "")
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            if phase in ("verify", "critic"):
                vdir = rc.run_dir / phase
                vdir.mkdir(parents=True, exist_ok=True)
                (vdir / "output.md").write_text(ACCEPT)
            return (0, "")
        return _p

    def test_gather_runs_first_when_enumerated_and_flag_on(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(),
            phase_commands={"gather": "claude --model cheap",
                            "verify": "claude --model other"},
            env={"AGENTRAIL_JIT_GATHER": "1"},
        )
        self.assertIn("gather", cap["phases"])
        # Gather is the FIRST phase — before test-author and execute.
        self.assertEqual(cap["phases"][0], "gather")
        self.assertLess(cap["phases"].index("gather"), cap["phases"].index("execute"))

    def test_gather_never_falls_back_to_implementer_command(self):
        # AC2: no "gather" entry in phase_commands → the phase is SKIPPED
        # ENTIRELY even with the flag ON. If the pipeline reached the generic
        # ``rc.phase_commands.get(phase, rc.agent_command)`` fallback for
        # gather, the phase would appear here running on the implementer's
        # command — it must not appear at all.
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(),
            phase_commands={"verify": "claude --model other"},
            env={"AGENTRAIL_JIT_GATHER": "1"},
        )
        self.assertNotIn("gather", cap["phases"])

    def test_flag_off_skips_gather_even_when_enumerated(self):
        # Flag-OFF neutrality at the pipeline layer: an enumerated gather
        # command is inert without AGENTRAIL_JIT_GATHER=1 (unset here).
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(),
            phase_commands={"gather": "claude --model cheap",
                            "verify": "claude --model other"},
        )
        self.assertNotIn("gather", cap["phases"])

    def test_flag_zero_skips_gather_even_when_enumerated(self):
        _, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(),
            phase_commands={"gather": "claude --model cheap",
                            "verify": "claude --model other"},
            env={"AGENTRAIL_JIT_GATHER": "0"},
        )
        self.assertNotIn("gather", cap["phases"])

    def test_flag_off_phase_sequence_is_unchanged(self):
        # The DEFAULT run (flag unset, nothing enumerated) produces the exact
        # phase sequence a no-gather run produces today.
        _, cap_default = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(),
            phase_commands={"verify": "claude --model other"},
        )
        _, cap_enumerated = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(),
            phase_commands={"gather": "claude --model cheap",
                            "verify": "claude --model other"},
        )
        self.assertEqual(cap_default["phases"], cap_enumerated["phases"])
        self.assertNotIn("gather", cap_default["phases"])

    def test_gather_failure_is_advisory_not_fatal(self):
        # Gather is a preparatory, advisory phase: its failure must not fail
        # the run — later phases proceed and the run can still reach done.
        result, cap = _run_issue_with_phase_stub(
            self.target, self.repo, self._phase(gather_status=1),
            phase_commands={"gather": "claude --model cheap",
                            "verify": "claude --model other"},
            env={"AGENTRAIL_JIT_GATHER": "1"},
        )
        self.assertIn("gather", cap["phases"])
        self.assertIn("execute", cap["phases"])
        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main()
