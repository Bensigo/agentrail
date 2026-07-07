"""Deterministic manifest handoff from the gather phase (issue #1049, PR C).

The JIT gather phase (PR B) produces a deterministic CONTEXT MANIFEST. This PR
captures that manifest ONCE per run from the gather phase's output artifact
(``rc.run_dir / "gather" / "output.md"``) onto ``RunContext.gather_manifest``
and injects it VERBATIM into the shared task context of every later phase, so
test-author / execute / verify share one byte-identical prefix (one warm-cache
key, AC1).

These tests pin the handoff's critical properties:

- **AC1**: the manifest bytes are identical across the test-author, execute,
  and verify prompts within one run (prefix-level and pipeline-level).
- **No-manifest regression**: with no manifest (flag off, gather skipped,
  gather failed, or empty output) ``shared_task_prefix`` and every phase
  prompt are byte-identical to pre-#1049 output — no empty section header, no
  stray separator. Those bytes are live cache identity.
- **Standalone gather prompt**: the gather prompt is NOT built on
  ``shared_task_prefix`` (different cheap model = separate cache scope) and
  never embeds a manifest itself (it PRODUCES the manifest).
- **Pipeline plumbing**: the manifest is captured once after a successful
  gather phase, stripped/gated, capped deterministically at capture time, and
  visible to every later phase of the run.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run import prompts
from agentrail.run.pipeline import RunContext, run_issue, run_issue_phase
from agentrail.run.prompts import (
    frame_untrusted_issue_context,
    issue_run_phase_prompt,
    shared_task_prefix,
)

ACCEPT = 'VERDICT: {"verdict":"accept","reason":"ok"}'

# A realistic manifest in the gather prompt's declared output format.
MANIFEST = (
    "CONTEXT MANIFEST\n"
    "Relevant files:\n"
    "- agentrail/run/pipeline.py:301-340 — phase prompt assembly for the AC\n"
    "Pinned symbols:\n"
    "- agentrail/run/pipeline.py:301 — def run_issue_phase(rc, phase, "
    "execution_attempt, ...)\n"
    "Checked, not relevant:\n"
    "- checked console/ — not relevant because the change is pipeline-only"
)

MANIFEST_HEADER = "Gathered context manifest (JIT gather phase, advisory):"

LATER_PHASES = ("test-author", "execute", "verify")


# ---------------------------------------------------------------------------
# Prefix-level: shared_task_prefix gating and verbatim injection
# ---------------------------------------------------------------------------

class SharedTaskPrefixManifestTests(unittest.TestCase):

    def _prefix(self, **overrides):
        kwargs = dict(
            issue=7,
            issue_context="SHARED-TASK-CONTEXT",
            base_prompt="SHARED-BASE-PROMPT",
            context_summary="SHARED-CONTEXT-PACK",
        )
        kwargs.update(overrides)
        return shared_task_prefix(**kwargs)

    def test_no_manifest_prefix_is_byte_identical_to_legacy_layout(self):
        # Regression pin: the exact pre-#1049 prefix bytes (cache identity).
        expected = (
            "Shared task context (issue #7):\n"
            "\n"
            "Issue context:\n"
            f"{frame_untrusted_issue_context('SHARED-TASK-CONTEXT')}\n"
            "\n"
            "Phase context pack:\n"
            "SHARED-CONTEXT-PACK\n"
            "\n"
            "Base instructions:\n"
            "SHARED-BASE-PROMPT\n"
        )
        self.assertEqual(self._prefix(), expected)

    def test_default_empty_and_whitespace_manifest_are_byte_identical(self):
        default = self._prefix()
        self.assertEqual(default, self._prefix(gather_manifest=""))
        self.assertEqual(default, self._prefix(gather_manifest="  \n\t \n"))
        self.assertNotIn(MANIFEST_HEADER, default)

    def test_manifest_is_injected_verbatim_between_pack_and_base(self):
        p = self._prefix(gather_manifest=MANIFEST)
        self.assertIn(
            "SHARED-CONTEXT-PACK\n"
            "\n"
            f"{MANIFEST_HEADER}\n"
            f"{MANIFEST}\n"
            "\n"
            "Base instructions:\n",
            p,
        )

    def test_manifest_is_strictly_additive(self):
        # Removing the manifest block from the with-manifest prefix must yield
        # the no-manifest prefix EXACTLY: nothing else moved or reworded.
        with_manifest = self._prefix(gather_manifest=MANIFEST)
        block = f"{MANIFEST_HEADER}\n{MANIFEST}\n\n"
        self.assertEqual(with_manifest.replace(block, "", 1), self._prefix())


# ---------------------------------------------------------------------------
# Prompt-level: issue_run_phase_prompt (warm + cold) and the gather branch
# ---------------------------------------------------------------------------

class PhasePromptManifestTests(unittest.TestCase):

    def _make(self, phase, *, warm_cache=True, gather_manifest="", **overrides):
        kwargs = dict(
            issue_context="SHARED-TASK-CONTEXT",
            base_prompt="SHARED-BASE-PROMPT",
            context_summary="SHARED-CONTEXT-PACK",
            red_green=True,
            warm_cache=warm_cache,
            gather_manifest=gather_manifest,
        )
        kwargs.update(overrides)
        return issue_run_phase_prompt(phase, 7, **kwargs)

    def _prefix(self, **overrides):
        kwargs = dict(
            issue=7,
            issue_context="SHARED-TASK-CONTEXT",
            base_prompt="SHARED-BASE-PROMPT",
            context_summary="SHARED-CONTEXT-PACK",
        )
        kwargs.update(overrides)
        return shared_task_prefix(**kwargs)

    def test_ac1_manifest_bytes_identical_across_the_three_phases(self):
        prefix = self._prefix(gather_manifest=MANIFEST)
        leading = [
            self._make(phase, gather_manifest=MANIFEST)[: len(prefix)]
            for phase in LATER_PHASES
        ]
        for phase, lead in zip(LATER_PHASES, leading):
            self.assertEqual(lead, prefix, f"{phase} prefix bytes differ")
        # One shared prefix = one warm-cache key across all three phases.
        self.assertEqual(len(set(leading)), 1)
        for phase in LATER_PHASES:
            prompt = self._make(phase, gather_manifest=MANIFEST)
            self.assertEqual(
                prompt.count(MANIFEST), 1,
                f"{phase}: manifest must appear exactly once, verbatim",
            )

    def test_no_manifest_prompts_are_byte_identical_to_today(self):
        for warm in (True, False):
            for phase in LATER_PHASES:
                default = self._make(phase, warm_cache=warm)
                self.assertEqual(
                    default,
                    self._make(phase, warm_cache=warm, gather_manifest="   \n"),
                    f"{phase} warm={warm}: whitespace manifest must be a no-op",
                )
                self.assertNotIn(MANIFEST_HEADER, default)

    def test_cold_no_manifest_inline_block_keeps_legacy_layout(self):
        # The cold inline shared-context block must keep its exact pre-#1049
        # layout when there is no manifest (AC4 byte-identity of cold prompts).
        legacy_inline = (
            "Issue context:\n"
            f"{frame_untrusted_issue_context('SHARED-TASK-CONTEXT')}\n"
            "\n"
            "Phase context pack:\n"
            "SHARED-CONTEXT-PACK\n"
            "\n"
            "Base instructions:\n"
            "SHARED-BASE-PROMPT\n"
        )
        self.assertIn(legacy_inline, self._make("test-author", warm_cache=False))

    def test_cold_prompt_carries_manifest_when_present(self):
        # Cold-path symmetry: a WARMCACHE-OFF ablation arm must not silently
        # drop the gather output — the inline block gets the same gated block.
        # Cold execute interleaves the plan after the context pack, so the
        # manifest block is followed by the plan section there; cold
        # test-author/verify embed the shared inline block ending in "Base
        # instructions:". Same gated block, same position after the pack.
        next_section = {
            "test-author": "Base instructions:\n",
            "execute": "Approved plan from the plan phase:\n",
            "verify": "Base instructions:\n",
        }
        for phase in LATER_PHASES:
            cold = self._make(phase, warm_cache=False, gather_manifest=MANIFEST)
            self.assertEqual(cold.count(MANIFEST), 1, phase)
            self.assertIn(
                "SHARED-CONTEXT-PACK\n"
                "\n"
                f"{MANIFEST_HEADER}\n"
                f"{MANIFEST}\n"
                "\n"
                + next_section[phase],
                cold,
                phase,
            )

    def test_gather_prompt_is_standalone_not_on_shared_prefix(self):
        # Gather runs on a SEPARATE cheap model (own cache scope): its prompt
        # must not be built on shared_task_prefix, and it never embeds a
        # manifest itself — it PRODUCES the manifest.
        g = self._make("gather", gather_manifest=MANIFEST)
        self.assertFalse(g.startswith(self._prefix(gather_manifest=MANIFEST)))
        self.assertFalse(g.startswith(self._prefix()))
        self.assertNotIn("Shared task context", g)
        self.assertNotIn(MANIFEST, g)
        self.assertNotIn(MANIFEST_HEADER, g)

    def test_gather_prompt_declares_the_deterministic_contract(self):
        g = self._make("gather")
        for marker in (
            "CONTEXT MANIFEST",
            "Relevant files:",
            "Pinned symbols:",
            "Checked, not relevant:",
            "agentrail context",
            "READ-ONLY",
            "SEQUENTIALLY",
            "DETERMINISTIC",
        ):
            self.assertIn(marker, g, marker)


# ---------------------------------------------------------------------------
# run_issue_phase level: rc.gather_manifest flows into the real stdin prompt
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


class RunIssuePhaseManifestTests(unittest.TestCase):
    """rc.gather_manifest is threaded into the actual phase stdin bytes."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.run_dir = Path(self._tmp.name) / "run"
        self.rc = _make_rc(self.target, self.run_dir)

    def tearDown(self):
        self._tmp.cleanup()

    def _stdin_for(self, phase):
        stub = _stub_run_with_timeout(0)
        full_env = {k: v for k, v in os.environ.items()
                    if not k.startswith("AGENTRAIL_EVAL_LAYER_WARMCACHE")}
        with patch.dict(os.environ, full_env, clear=True), \
                patch("agentrail.run.pipeline.ctx.build_issue_context_pack",
                      return_value=None), \
                patch("agentrail.run.pipeline.ctx.context_pack_summary",
                      return_value="ctx summary"), \
                patch("agentrail.run.pipeline.run_with_timeout", stub):
            run_issue_phase(self.rc, phase, 1)
        return stub.calls[0]["stdin_text"]

    def _prefix(self, gather_manifest=""):
        return prompts.shared_task_prefix(
            issue=self.rc.issue,
            issue_context=self.rc.resolution_text,
            base_prompt=self.rc.base_prompt,
            context_summary="ctx summary",
            gather_manifest=gather_manifest,
        )

    def test_manifest_on_rc_leads_every_phase_prompt_identically(self):
        self.rc.gather_manifest = MANIFEST
        prefix = self._prefix(gather_manifest=MANIFEST)
        for phase in LATER_PHASES:
            stdin = self._stdin_for(phase)
            self.assertEqual(stdin[: len(prefix)], prefix,
                             f"{phase}: manifest prefix bytes differ")
            self.assertEqual(stdin.count(MANIFEST), 1, phase)

    def test_default_rc_prompt_bytes_are_unchanged(self):
        # rc.gather_manifest defaults to "" → the live prompt is byte-for-byte
        # the pre-#1049 prompt (leads with the manifest-free prefix, no header).
        prefix = self._prefix()
        for phase in LATER_PHASES:
            stdin = self._stdin_for(phase)
            self.assertEqual(stdin[: len(prefix)], prefix, phase)
            self.assertNotIn(MANIFEST_HEADER, stdin, phase)


# ---------------------------------------------------------------------------
# run_issue level: capture-once from the gather output artifact
# ---------------------------------------------------------------------------

def _clean_env(**overrides):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("AGENTRAIL_EVAL_LAYER_")
           and k not in ("AGENTRAIL_JIT_GATHER", "AGENTRAIL_EVAL_GATHER_MODEL",
                         "AGENTRAIL_PHASE_INLINE_MAX_CHARS")}
    env["AGENTRAIL_EVAL_LAYER_BESTOFN"] = "0"
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


def _run_issue_with_phase_stub(target, repo, phase_stub, phase_commands=None,
                               env=None):
    """run_issue with run_issue_phase stubbed (faithful signature) — records
    (phase, rc.gather_manifest-at-call-time) so tests can see exactly which
    manifest bytes each phase's prompt build would receive."""
    captured = {"seen": []}

    def _wrapped(rc, phase, attempt, verifier_findings_file="", plan_output=""):
        captured["seen"].append((phase, rc.gather_manifest))
        return phase_stub(rc, phase, attempt, verifier_findings_file, plan_output)

    gh_mock = MagicMock()
    gh_mock.returncode = 1
    gh_mock.stdout = ""

    with _clean_env(**(env or {})), \
         patch("agentrail.run.pipeline.ctx.issue_resolution_text", return_value="T"), \
         patch("agentrail.run.pipeline.skills.resolve_skills",
               return_value={"resolved": [], "autoSkills": True}), \
         patch("agentrail.run.pipeline.ctx.build_issue_context_pack",
               return_value="pack.json"), \
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
         patch("agentrail.run.pipeline.state_mod.update_run_state"), \
         patch("agentrail.run.pipeline.artifacts.update_run_metadata_attempts"), \
         patch("agentrail.run.pipeline.subprocess.run", return_value=gh_mock):
        result = run_issue(target, 7, agent="claude", command="c", repo_dir=repo,
                           phase_commands=phase_commands)
    return result, captured


class ManifestCaptureTests(unittest.TestCase):
    """The pipeline captures the gather output artifact ONCE onto
    rc.gather_manifest — stripped, gated, and capped at capture time."""

    GATHER_COMMANDS = {"gather": "claude --model cheap",
                       "verify": "claude --model other"}

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.target = _make_target(self._tmp.name)
        self.repo = Path(self._tmp.name) / "repo"
        self.repo.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _phase(self, gather_status=0, gather_output=MANIFEST + "\n"):
        """Faithful stub: the real run_issue_phase writes the agent's output to
        rc.run_dir/<phase>/output.md (attempt 1), which is exactly where the
        capture code reads the gather manifest from."""
        def _p(rc, phase, attempt, vff, plan_output):
            if phase == "gather":
                if gather_output is not None:
                    gdir = rc.run_dir / "gather"
                    gdir.mkdir(parents=True, exist_ok=True)
                    (gdir / "output.md").write_text(gather_output,
                                                    encoding="utf-8")
                return (gather_status, "")
            if phase == "execute":
                _sentinel(self.target).write_text("x")
            if phase in ("verify", "critic"):
                vdir = rc.run_dir / phase
                vdir.mkdir(parents=True, exist_ok=True)
                (vdir / "output.md").write_text(ACCEPT)
            return (0, "")
        return _p

    def _run(self, phase_stub, env=None):
        full_env = {"AGENTRAIL_JIT_GATHER": "1"}
        full_env.update(env or {})
        return _run_issue_with_phase_stub(
            self.target, self.repo, phase_stub,
            phase_commands=dict(self.GATHER_COMMANDS), env=full_env)

    @staticmethod
    def _manifests_after_gather(captured):
        phases = [p for p, _ in captured["seen"]]
        after = phases.index("gather") + 1
        return captured["seen"][after:]

    def test_manifest_captured_once_and_shared_by_all_later_phases(self):
        _, cap = self._run(self._phase())
        phases = [p for p, _ in cap["seen"]]
        self.assertEqual(phases[0], "gather")
        for phase in LATER_PHASES:
            self.assertIn(phase, phases)
        # At gather time nothing is captured yet — capture happens AFTER.
        self.assertEqual(cap["seen"][0], ("gather", ""))
        later = self._manifests_after_gather(cap)
        self.assertTrue(later)
        for phase, manifest in later:
            self.assertEqual(manifest, MANIFEST,
                             f"{phase}: must see the same manifest bytes")

    def test_failed_gather_captures_nothing(self):
        # Advisory failure: the run continues, but a failed gather's output is
        # NOT trusted as a manifest — later prompts stay byte-identical to a
        # run without gather.
        result, cap = self._run(self._phase(gather_status=1))
        self.assertEqual(result, 0)
        later = self._manifests_after_gather(cap)
        self.assertTrue(later)
        for phase, manifest in later:
            self.assertEqual(manifest, "", phase)

    def test_whitespace_only_gather_output_captures_nothing(self):
        _, cap = self._run(self._phase(gather_output="   \n\n\t\n"))
        for phase, manifest in self._manifests_after_gather(cap):
            self.assertEqual(manifest, "", phase)

    def test_missing_gather_output_file_captures_nothing(self):
        _, cap = self._run(self._phase(gather_output=None))
        for phase, manifest in self._manifests_after_gather(cap):
            self.assertEqual(manifest, "", phase)

    def test_surrounding_whitespace_is_stripped_before_injection(self):
        _, cap = self._run(self._phase(gather_output=f"\n\n{MANIFEST}\n\n"))
        for phase, manifest in self._manifests_after_gather(cap):
            self.assertEqual(manifest, MANIFEST, phase)

    def test_oversized_manifest_is_capped_once_at_capture_time(self):
        # The cap is applied ONCE at capture, so every later phase injects the
        # same already-capped bytes (deterministic within the run) and the
        # truncation note points at the phase output artifact.
        big = "CONTEXT MANIFEST\n" + ("x" * 500)
        env = {"AGENTRAIL_PHASE_INLINE_MAX_CHARS": "100"}
        with patch.dict(os.environ, env):
            expected = prompts.bounded_phase_text(big, "gather context manifest")
        self.assertLess(len(expected), len(big) + 1)
        self.assertIn("[AgentRail truncated gather context manifest:", expected)
        _, cap = self._run(self._phase(gather_output=big), env=env)
        later = self._manifests_after_gather(cap)
        self.assertTrue(later)
        for phase, manifest in later:
            self.assertEqual(manifest, expected, phase)


if __name__ == "__main__":
    unittest.main()
