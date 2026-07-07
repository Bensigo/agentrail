"""Flag-flip cleanup + AC3 gap tests for the JIT gather seam (issue #1049, PR D).

Two gaps the existing suites leave open:

1. **AC3a — pack-not-built.** ``tests/run/test_gather_pipeline.py`` pins that
   the gather PHASE is skipped when ``AGENTRAIL_JIT_GATHER`` is unset/``"0"``,
   but its harness stubs ``run_issue_phase`` entirely, so nothing asserts the
   gather branch never builds a ``phase="gather"`` context pack. Here the
   gather phase delegates to the REAL ``run_issue_phase`` (agent process and
   pack building mocked at their own seams), so the pack-recording assertions
   are non-vacuous: if the pipeline DID run gather, the real gather branch
   would reach the recording pack mock.

   AC3b note: the ctx-layer run_id pin (deterministic pack_id/artifact path)
   is already covered by ``tests/context/test_gather_pack_phase.py`` — only
   the PIPELINE pass-through (``run_issue_phase`` forwards ``run_id=rc.run_id``
   for ``phase="gather"``, and only for gather) is pinned here.

2. **Stale forced-context cleanup.** When :func:`forced_context_enabled`
   flips OFF after a prior emit, ``emit_forced_context`` becomes a no-op but
   the artifacts it wrote persist — the claude hook keeps force-injecting a
   stale gather-derived context every turn. ``remove_forced_context`` is the
   inverse; these tests pin its per-engine behavior against REAL
   ``emit_forced_context`` output (no mocking of the module under test) and
   the pipeline seam that invokes it.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agentrail.run.context_inject import (
    AGENTS_MD,
    CLAUDE_HOOK_SCRIPT,
    CLAUDE_SETTINGS,
    CONTEXT_MD,
    CURSOR_RULE,
    _AGENTS_END,
    _AGENTS_START,
    emit_forced_context,
    remove_forced_context,
)
from agentrail.run.pipeline import RunContext, run_issue, run_issue_phase

ACCEPT = 'VERDICT: {"verdict":"accept","reason":"ok"}'
CONTEXT = "RETRIEVED-CTX: the auth handler lives in src/auth.py::login (line 42)."

# Direct reference captured BEFORE any patch of agentrail.run.pipeline.run_issue_phase,
# so the run_issue-level harness can delegate the gather phase to the real code.
_REAL_RUN_ISSUE_PHASE = run_issue_phase


# ---------------------------------------------------------------------------
# Shared harness (mirrors tests/run/test_gather_pipeline.py /
# tests/run/test_gather_manifest_handoff.py)
# ---------------------------------------------------------------------------

def _make_target(tmp_dir: str) -> Path:
    target = Path(tmp_dir) / "target"
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    (agentrail_dir / "state.json").write_text(json.dumps({"workflow": {}}))
    (agentrail_dir / "config.json").write_text(
        json.dumps({"verify": f"test -f {target / 'impl_done'}"})
    )
    return target


def _sentinel(target: Path) -> Path:
    return target / "impl_done"


def _make_rc(target: Path, run_dir: Path) -> RunContext:
    return RunContext(
        target_dir=target,
        repo_dir=target,
        issue=42,
        agent="claude",
        agent_command="claude --dangerously-skip-permissions",
        run_id="run-abc123",
        run_dir=run_dir,
        started_at="2026-06-10T00:00:00Z",
        metadata_file=run_dir / "run.json",
        base_prompt="Do the thing.",
        resolution_text="Fix the bug.\n\n## Acceptance criteria\n- [ ] It works.",
        run_context_pack_file=None,
        max_execution_attempts=5,
        agent_timeout=1800,
        failed_verification_attempts=0,
    )


def _stub_run_with_timeout(return_code: int, output_text: str = "agent output"):
    def _stub(argv, *, cwd, timeout, output_file, stdin_text=None, env=None):
        _stub.calls.append({"argv": argv, "stdin_text": stdin_text,
                            "output_file": output_file})
        output_file.write_text(output_text)
        return return_code
    _stub.calls = []
    return _stub


def _clean_env(**overrides):
    # Strip ablation layers, the gather flag AND the forced-context flag so
    # each test states its own environment explicitly: the gather flag must
    # default OFF, and forced-context DEFAULTS ON when absent — a leaked
    # AGENTRAIL_FORCED_CONTEXT from the outer shell (e.g. the AFK env) would
    # invalidate the seam tests.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")
           and k not in ("AGENTRAIL_JIT_GATHER", "AGENTRAIL_EVAL_GATHER_MODEL",
                         "AGENTRAIL_PHASE_INLINE_MAX_CHARS",
                         "AGENTRAIL_FORCED_CONTEXT")}
    env["AGENTRAIL_EVAL_LAYER_BESTOFN"] = "0"
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


def _run_issue_real_gather(target, repo, phase_commands=None, env=None):
    """run_issue with every phase stubbed EXCEPT gather, which delegates to
    the REAL run_issue_phase (agent process + context-pack building mocked at
    their own seams). The returned pack mock records every
    ctx.build_issue_context_pack call, so "no gather pack was built" is a
    non-vacuous assertion — the real gather branch WOULD reach it."""
    captured = {"phases": [], "run_id": None}
    pack_mock = MagicMock(return_value="pack.json")
    run_stub = _stub_run_with_timeout(0)

    def _wrapped(rc, phase, attempt, verifier_findings_file="", plan_output=""):
        captured["phases"].append(phase)
        captured["run_id"] = rc.run_id
        if phase == "gather":
            return _REAL_RUN_ISSUE_PHASE(rc, phase, attempt,
                                         verifier_findings_file, plan_output)
        if phase == "execute":
            _sentinel(target).write_text("x")
        if phase in ("verify", "critic"):
            vdir = rc.run_dir / phase
            vdir.mkdir(parents=True, exist_ok=True)
            (vdir / "output.md").write_text(ACCEPT)
        return (0, "")

    gh_mock = MagicMock()
    gh_mock.returncode = 1
    gh_mock.stdout = ""

    # Pin forced-context OFF so the real gather phase never writes engine
    # artifacts into the tmp workdir (remove_forced_context no-ops there).
    base_env = {"AGENTRAIL_FORCED_CONTEXT": "0"}
    base_env.update(env or {})

    with _clean_env(**base_env), \
         patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
         patch("agentrail.run.pipeline.skills.resolve_skills",
               return_value={"resolved": [], "autoSkills": True}), \
         patch("agentrail.run.pipeline.ctx.build_issue_context_pack", pack_mock), \
         patch("agentrail.run.pipeline.ctx.context_pack_summary",
               return_value="SUMMARY"), \
         patch("agentrail.run.pipeline.ctx.context_selected_snippets",
               return_value="SNIPPETS"), \
         patch("agentrail.run.pipeline.ctx.context_retrieval_metadata",
               return_value={}), \
         patch("agentrail.run.pipeline.state_mod.render_state_summary",
               return_value=""), \
         patch("agentrail.run.pipeline.prompts.common_header", return_value=""), \
         patch("agentrail.run.pipeline.prompts.format_skill_resolution",
               return_value=""), \
         patch("agentrail.run.pipeline.prompts.issue_base_prompt",
               return_value="BP"), \
         patch("agentrail.run.pipeline.run_issue_phase", side_effect=_wrapped), \
         patch("agentrail.run.pipeline.run_with_timeout", run_stub), \
         patch("agentrail.run.pipeline.state_mod.update_run_state"), \
         patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
         patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
        result = run_issue(target, 7, agent="claude", command="c", repo_dir=repo,
                           phase_commands=phase_commands)
    return result, captured, pack_mock


def _gather_pack_calls(pack_mock):
    calls = []
    for c in pack_mock.call_args_list:
        phase = c.args[2] if len(c.args) >= 3 else c.kwargs.get("phase")
        if phase == "gather":
            calls.append(c)
    return calls


# ---------------------------------------------------------------------------
# AC3a: flag OFF → the gather branch never builds a phase="gather" pack
# ---------------------------------------------------------------------------

class GatherPackNotBuiltTests(unittest.TestCase):
    """Existing tests pin "the gather phase is skipped"; these pin the
    stronger property "no gather context pack is ever built" (AC3a)."""

    GATHER_COMMANDS = {"gather": "claude --model cheap",
                       "verify": "claude --model other"}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_flag_unset_never_builds_gather_pack(self):
        _, cap, pack_mock = _run_issue_real_gather(
            self.target, self.repo, phase_commands=self.GATHER_COMMANDS)
        self.assertNotIn("gather", cap["phases"])
        self.assertEqual(_gather_pack_calls(pack_mock), [])
        # Harness sanity: packs ARE built for the run — the empty gather list
        # above is not an artifact of a dead mock.
        self.assertTrue(pack_mock.called)

    def test_flag_zero_never_builds_gather_pack(self):
        _, cap, pack_mock = _run_issue_real_gather(
            self.target, self.repo, phase_commands=self.GATHER_COMMANDS,
            env={"AGENTRAIL_JIT_GATHER": "0"})
        self.assertNotIn("gather", cap["phases"])
        self.assertEqual(_gather_pack_calls(pack_mock), [])
        self.assertTrue(pack_mock.called)

    def test_flag_on_builds_exactly_one_run_pinned_gather_pack(self):
        # Vacuousness guard for the two tests above AND the run_issue-level
        # half of AC3b: with the flag ON the SAME harness records the real
        # gather branch building one fresh pack pinned to this run's run_id.
        _, cap, pack_mock = _run_issue_real_gather(
            self.target, self.repo, phase_commands=self.GATHER_COMMANDS,
            env={"AGENTRAIL_JIT_GATHER": "1"})
        self.assertIn("gather", cap["phases"])
        calls = _gather_pack_calls(pack_mock)
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(Path(call.args[0]).resolve(), self.target.resolve())
        self.assertEqual(call.args[1], 7)
        self.assertTrue(cap["run_id"])
        self.assertEqual(call.kwargs, {"run_id": cap["run_id"]})


# ---------------------------------------------------------------------------
# AC3b (pipeline half): run_issue_phase forwards run_id ONLY for gather
# ---------------------------------------------------------------------------

class GatherRunPinPassThroughTests(unittest.TestCase):
    """The ctx-layer pin (deterministic pack_id from run_id) is covered by
    tests/context/test_gather_pack_phase.py; here we pin the pipeline
    pass-through: gather gets ``run_id=rc.run_id``, other phases do not."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(self.target, self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    def _run_phase(self, phase, pack_mock):
        stub = _stub_run_with_timeout(0)
        with _clean_env(AGENTRAIL_FORCED_CONTEXT="0"), \
                patch("agentrail.run.pipeline.ctx.build_issue_context_pack",
                      pack_mock), \
                patch("agentrail.run.pipeline.ctx.context_pack_summary",
                      return_value="ctx summary"), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, phase, 1)

    def test_gather_pack_is_pinned_to_the_run(self):
        pack_mock = MagicMock(return_value=None)
        self._run_phase("gather", pack_mock)
        pack_mock.assert_called_once_with(
            self.rc.target_dir, self.rc.issue, "gather", run_id=self.rc.run_id)

    def test_non_gather_pack_is_not_run_pinned(self):
        pack_mock = MagicMock(return_value=None)
        self._run_phase("execute", pack_mock)
        pack_mock.assert_called_once_with(
            self.rc.target_dir, self.rc.issue, "execute")


# ---------------------------------------------------------------------------
# Pipeline seam 6b: enabled → emit, disabled → remove
# ---------------------------------------------------------------------------

class ForcedContextSeamTests(unittest.TestCase):
    """run_issue_phase's forced-context seam calls remove_forced_context
    whenever the flag resolves OFF (and only then) — so a flag flip actively
    cleans previously-emitted artifacts instead of leaving them to force
    stale context every turn."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(self.target, self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    def _run_execute(self, flag_value, emit_calls, remove_calls):
        # Faithful fakes: each pins the real function's signature.
        def _fake_flag(workdir):
            return flag_value

        def _fake_emit(engine, workdir, context_text):
            emit_calls.append((engine, workdir, context_text))
            return []

        def _fake_remove(workdir):
            remove_calls.append(workdir)
            return []

        stub = _stub_run_with_timeout(0)
        with _clean_env(), \
                patch("agentrail.run.pipeline.forced_context_enabled",
                      _fake_flag), \
                patch("agentrail.run.pipeline.emit_forced_context", _fake_emit), \
                patch("agentrail.run.pipeline.remove_forced_context",
                      _fake_remove), \
                patch("agentrail.run.pipeline.ctx.build_issue_context_pack",
                      return_value=None), \
                patch("agentrail.run.pipeline.ctx.context_pack_summary",
                      return_value="ctx summary"), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

    def test_flag_off_calls_remove_and_never_emit(self):
        emit_calls, remove_calls = [], []
        self._run_execute(False, emit_calls, remove_calls)
        self.assertEqual(remove_calls, [self.rc.target_dir])
        self.assertEqual(emit_calls, [])

    def test_flag_on_emits_and_never_removes(self):
        emit_calls, remove_calls = [], []
        self._run_execute(True, emit_calls, remove_calls)
        self.assertEqual(emit_calls,
                         [(self.rc.agent, self.rc.target_dir, "ctx summary")])
        self.assertEqual(remove_calls, [])

    def test_flag_flip_off_physically_removes_stale_claude_artifacts(self):
        # End-to-end, no seam mocking: a prior enabled run left real claude
        # artifacts behind; the next flag-OFF phase must scrub them.
        with _clean_env(AGENTRAIL_FORCED_CONTEXT="1"):
            written = emit_forced_context("claude", self.target, CONTEXT)
        self.assertIn(CONTEXT_MD, written)
        self.assertTrue((self.target / CLAUDE_HOOK_SCRIPT).is_file())

        stub = _stub_run_with_timeout(0)
        with _clean_env(AGENTRAIL_FORCED_CONTEXT="0"), \
                patch("agentrail.run.pipeline.ctx.build_issue_context_pack",
                      return_value=None), \
                patch("agentrail.run.pipeline.ctx.context_pack_summary",
                      return_value="ctx summary"), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, "execute", 1)

        self.assertFalse((self.target / CONTEXT_MD).exists())
        self.assertFalse((self.target / CLAUDE_HOOK_SCRIPT).exists())
        settings = json.loads((self.target / CLAUDE_SETTINGS).read_text())
        self.assertNotIn("UserPromptSubmit", settings.get("hooks", {}))


# ---------------------------------------------------------------------------
# remove_forced_context unit behavior (real emits, real removals)
# ---------------------------------------------------------------------------

@pytest.fixture
def on(monkeypatch):
    """Force the emit flag ON so real emit_forced_context writes artifacts."""
    monkeypatch.setenv("AGENTRAIL_FORCED_CONTEXT", "1")


class TestRemoveForcedContext:
    def test_claude_artifacts_removed_and_hook_deregistered(self, tmp_path, on):
        assert emit_forced_context("claude", tmp_path, CONTEXT)
        removed = remove_forced_context(tmp_path)
        assert removed == [CONTEXT_MD, CLAUDE_HOOK_SCRIPT, CLAUDE_SETTINGS]
        assert not (tmp_path / CONTEXT_MD).exists()
        assert not (tmp_path / CLAUDE_HOOK_SCRIPT).exists()
        settings = json.loads((tmp_path / CLAUDE_SETTINGS).read_text())
        assert "UserPromptSubmit" not in settings.get("hooks", {})

    def test_user_hook_entries_and_settings_survive(self, tmp_path, on):
        user_entry = {"hooks": [{"type": "command",
                                 "command": "./my-own-hook.sh"}]}
        pre_tool = [{"matcher": "Bash", "hooks": []}]
        settings_path = tmp_path / CLAUDE_SETTINGS
        settings_path.parent.mkdir(parents=True)
        settings_path.write_text(json.dumps({
            "model": "opus",
            "hooks": {"UserPromptSubmit": [user_entry], "PreToolUse": pre_tool},
        }))
        emit_forced_context("claude", tmp_path, CONTEXT)
        removed = remove_forced_context(tmp_path)
        assert CLAUDE_SETTINGS in removed
        settings = json.loads(settings_path.read_text())
        assert settings["model"] == "opus"
        assert settings["hooks"]["UserPromptSubmit"] == [user_entry]
        assert settings["hooks"]["PreToolUse"] == pre_tool

    def test_legacy_bare_hook_command_is_deregistered(self, tmp_path):
        # Older emitters registered the bare relative spelling; removal must
        # recognise it as ours too.
        settings_path = tmp_path / CLAUDE_SETTINGS
        settings_path.parent.mkdir(parents=True)
        settings_path.write_text(json.dumps({"hooks": {"UserPromptSubmit": [
            {"hooks": [{"type": "command",
                        "command": ".agentrail/hooks/forced-context.sh"}]},
        ]}}))
        removed = remove_forced_context(tmp_path)
        assert removed == [CLAUDE_SETTINGS]
        settings = json.loads(settings_path.read_text())
        assert "UserPromptSubmit" not in settings["hooks"]

    def test_agents_md_content_outside_markers_survives(self, tmp_path, on):
        user_text = "# House rules\n\nAlways run the linter.\n"
        (tmp_path / AGENTS_MD).write_text(user_text)
        emit_forced_context("codex", tmp_path, CONTEXT)
        removed = remove_forced_context(tmp_path)
        assert removed == [AGENTS_MD]
        text = (tmp_path / AGENTS_MD).read_text()
        assert text.startswith(user_text)
        assert text.strip() == user_text.strip()  # only whitespace may differ
        assert _AGENTS_START not in text
        assert _AGENTS_END not in text
        assert CONTEXT not in text

    def test_agents_md_deleted_when_only_managed_block_remains(self, tmp_path, on):
        emit_forced_context("codex", tmp_path, CONTEXT)
        removed = remove_forced_context(tmp_path)
        assert removed == [AGENTS_MD]
        assert not (tmp_path / AGENTS_MD).exists()

    def test_cursor_rule_removed(self, tmp_path, on):
        emit_forced_context("cursor", tmp_path, CONTEXT)
        assert (tmp_path / CURSOR_RULE).is_file()
        removed = remove_forced_context(tmp_path)
        assert removed == [CURSOR_RULE]
        assert not (tmp_path / CURSOR_RULE).exists()

    def test_all_engines_cleaned_in_one_call(self, tmp_path, on):
        for engine in ("claude", "codex", "cursor"):
            emit_forced_context(engine, tmp_path, CONTEXT)
        removed = remove_forced_context(tmp_path)
        assert removed == [CONTEXT_MD, CLAUDE_HOOK_SCRIPT, CLAUDE_SETTINGS,
                           AGENTS_MD, CURSOR_RULE]
        for rel in (CONTEXT_MD, CLAUDE_HOOK_SCRIPT, AGENTS_MD, CURSOR_RULE):
            assert not (tmp_path / rel).exists()

    def test_pristine_workdir_is_a_silent_noop(self, tmp_path):
        assert remove_forced_context(tmp_path) == []
        assert list(tmp_path.iterdir()) == []

    def test_second_call_is_idempotent(self, tmp_path, on):
        for engine in ("claude", "codex", "cursor"):
            emit_forced_context(engine, tmp_path, CONTEXT)
        assert remove_forced_context(tmp_path)  # first call cleans
        settings_before = (tmp_path / CLAUDE_SETTINGS).read_text()
        assert remove_forced_context(tmp_path) == []
        assert (tmp_path / CLAUDE_SETTINGS).read_text() == settings_before


if __name__ == "__main__":
    unittest.main()
