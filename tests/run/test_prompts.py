"""Unit tests for agentrail/run/prompts.py.

Pure string-builder functions that reproduce legacy bash prompt text.
No I/O — all functions are tested without file system access.
"""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch


class BoundedPhaseTextTests(unittest.TestCase):
    """Tests for bounded_phase_text()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import bounded_phase_text
        return bounded_phase_text(*args, **kwargs)

    def test_empty_string_returns_empty(self):
        self.assertEqual(self._fn(""), "")

    def test_short_text_unchanged_with_default_env(self):
        # Unset the env var to rely on default 12000
        env = {k: v for k, v in os.environ.items()
               if k != "AGENTRAIL_PHASE_INLINE_MAX_CHARS"}
        with patch.dict(os.environ, env, clear=True):
            text = "Hello, world!"
            self.assertEqual(self._fn(text), text)

    def test_over_limit_truncates_with_note(self):
        text = "x" * 50
        with patch.dict(os.environ, {"AGENTRAIL_PHASE_INLINE_MAX_CHARS": "10"}):
            result = self._fn(text, label="phase text")
        self.assertTrue(result.startswith("x" * 10))
        self.assertIn("AgentRail truncated", result)
        self.assertIn("phase text", result)
        self.assertIn("shown first 10 of 50 characters", result)
        self.assertIn("See the phase output artifact for the full text.", result)

    def test_invalid_env_falls_back_to_24000(self):
        text = "y" * 25000
        with patch.dict(os.environ, {"AGENTRAIL_PHASE_INLINE_MAX_CHARS": "abc"}):
            result = self._fn(text)
        self.assertTrue(result.startswith("y" * 24000))
        self.assertIn("AgentRail truncated", result)
        self.assertIn("shown first 24000 of 25000 characters", result)

    def test_exactly_at_limit_not_truncated(self):
        text = "z" * 10
        with patch.dict(os.environ, {"AGENTRAIL_PHASE_INLINE_MAX_CHARS": "10"}):
            result = self._fn(text)
        self.assertEqual(result, text)

    def test_custom_label_appears_in_note(self):
        text = "a" * 20
        with patch.dict(os.environ, {"AGENTRAIL_PHASE_INLINE_MAX_CHARS": "5"}):
            result = self._fn(text, label="plan output")
        self.assertIn("plan output", result)


class CommonHeaderTests(unittest.TestCase):
    """Tests for common_header()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import common_header
        return common_header(*args, **kwargs)

    def test_contains_opening_line(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("You are working in an AgentRail-managed repository.", result)

    def test_contains_agent_target(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("Agent target: claude", result)

    def test_contains_context_md_line(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("- CONTEXT.md", result)

    def test_contains_taste_md_line(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("- TASTE.md when present", result)

    def test_contains_docs_agents_line(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("- relevant docs under docs/agents/", result)

    def test_contains_memory_recall_line(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("- relevant project memory from agentrail memory recall", result)

    def test_contains_cli_state_section(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("Start with AgentRail CLI state:", result)
        self.assertIn("- agentrail status", result)
        self.assertIn("- agentrail resume", result)

    def test_contains_state_summary_section_header(self):
        result = self._fn("claude", "- state: ok")
        self.assertIn("AgentRail state summary:", result)

    def test_contains_state_summary_value(self):
        summary = "- AgentRail state: running"
        result = self._fn("myagent", summary)
        self.assertIn(summary, result)

    def test_ends_with_newline_after_state_summary(self):
        summary = "- state: ok"
        result = self._fn("claude", summary)
        # Should end with the state_summary line followed by a newline
        self.assertTrue(result.endswith(summary + "\n"))

    def test_different_agent_name(self):
        result = self._fn("gpt-4o", "- state: none")
        self.assertIn("Agent target: gpt-4o", result)


class FormatSkillResolutionTests(unittest.TestCase):
    """Tests for format_skill_resolution()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import format_skill_resolution
        return format_skill_resolution(*args, **kwargs)

    def test_empty_resolved_with_auto_skills_true(self):
        resolution = {"autoSkills": True, "resolved": []}
        result = self._fn(resolution)
        self.assertIn("Resolved AgentRail skills:", result)
        self.assertIn("- No skills resolved.", result)
        self.assertNotIn("disabled", result)

    def test_empty_resolved_with_auto_skills_false(self):
        resolution = {"autoSkills": False, "resolved": []}
        result = self._fn(resolution)
        self.assertIn("Resolved AgentRail skills:", result)
        self.assertIn("- Automatic skill resolution disabled.", result)
        self.assertIn("- No skills resolved.", result)

    def test_non_empty_resolved_contains_skill_name(self):
        resolution = {
            "autoSkills": True,
            "resolved": [
                {"name": "tdd", "localPath": "skills/tdd/SKILL.md", "reasons": ["task keyword: test"]}
            ],
        }
        result = self._fn(resolution)
        self.assertIn("- tdd", result)

    def test_non_empty_resolved_contains_path(self):
        resolution = {
            "autoSkills": True,
            "resolved": [
                {"name": "tdd", "localPath": "skills/tdd/SKILL.md", "reasons": ["task keyword: test"]}
            ],
        }
        result = self._fn(resolution)
        self.assertIn("  path: skills/tdd/SKILL.md", result)

    def test_non_empty_resolved_contains_reason(self):
        resolution = {
            "autoSkills": True,
            "resolved": [
                {"name": "tdd", "localPath": "skills/tdd/SKILL.md", "reasons": ["task keyword: test"]}
            ],
        }
        result = self._fn(resolution)
        self.assertIn("  reason: task keyword: test", result)

    def test_non_empty_resolved_contains_read_skills_line(self):
        resolution = {
            "autoSkills": True,
            "resolved": [
                {"name": "tdd", "localPath": "skills/tdd/SKILL.md", "reasons": ["task keyword: test"]}
            ],
        }
        result = self._fn(resolution)
        self.assertIn(
            "Read these SKILL.md files before editing. If a resolved skill does not apply after inspection, report that in the PR or run notes.",
            result,
        )

    def test_ends_with_trailing_blank_line(self):
        resolution = {"autoSkills": True, "resolved": []}
        result = self._fn(resolution)
        self.assertTrue(result.endswith("\n"))

    def test_non_empty_ends_with_trailing_blank_line(self):
        resolution = {
            "autoSkills": True,
            "resolved": [
                {"name": "tdd", "localPath": "skills/tdd/SKILL.md", "reasons": ["task keyword: test"]}
            ],
        }
        result = self._fn(resolution)
        self.assertTrue(result.endswith("\n"))

    def test_multiple_reasons(self):
        resolution = {
            "autoSkills": True,
            "resolved": [
                {
                    "name": "tdd",
                    "localPath": "skills/tdd/SKILL.md",
                    "reasons": ["task keyword: test", "explicit"],
                }
            ],
        }
        result = self._fn(resolution)
        self.assertIn("  reason: task keyword: test", result)
        self.assertIn("  reason: explicit", result)

    def test_mode_not_prompt_raises(self):
        from agentrail.run.prompts import format_skill_resolution
        resolution = {"autoSkills": True, "resolved": []}
        with self.assertRaises(NotImplementedError):
            format_skill_resolution(resolution, mode="cli")


class IssueBasePromptTests(unittest.TestCase):
    """Tests for issue_base_prompt()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import issue_base_prompt
        return issue_base_prompt(*args, **kwargs)

    def _make(self, agent="claude", issue=7):
        return self._fn(
            agent,
            issue,
            header="HEADER\n",
            skill_block="SKILLS\n",
            context_summary="SUMMARY",
            context_snippets="SNIPPETS",
        )

    def test_codex_first_line(self):
        result = self._fn(
            "codex", 7,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn(
            "Run one bounded AgentRail issue execution for exactly one GitHub issue: #7.",
            result,
        )

    def test_claude_first_line(self):
        result = self._fn(
            "claude", 7,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn(
            "Use Claude Code through AgentRail to run one bounded implementation loop for exactly one GitHub issue: #7.",
            result,
        )

    def test_codex_handle_only(self):
        result = self._make("codex")
        self.assertIn("Handle only issue #7.", result)

    def test_claude_handle_only(self):
        result = self._make("claude")
        self.assertIn("Handle only issue #7.", result)

    def test_issue_number_substitution_codex(self):
        result = self._fn(
            "codex", 42,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn("#42", result)
        self.assertNotIn("#7", result)

    def test_issue_number_substitution_claude(self):
        result = self._fn(
            "claude", 42,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn("#42", result)

    def test_header_appears_first(self):
        result = self._make()
        self.assertTrue(result.startswith("HEADER\n"))

    def test_skill_block_appears_after_header(self):
        result = self._make()
        idx_header = result.index("HEADER\n")
        idx_skills = result.index("SKILLS\n")
        self.assertLess(idx_header, idx_skills)

    def test_context_summary_appears(self):
        result = self._make()
        self.assertIn("SUMMARY", result)

    def test_context_snippets_appears(self):
        result = self._make()
        self.assertIn("SNIPPETS", result)

    def test_context_summary_before_snippets(self):
        result = self._make()
        self.assertLess(result.index("SUMMARY"), result.index("SNIPPETS"))

    def test_unknown_agent_uses_claude_block(self):
        result = self._fn(
            "gpt-4o", 7,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn("Use Claude Code through AgentRail", result)

    def test_agentrail_run_issue_substitution_codex(self):
        """The 'agentrail run issue {issue}' line should have the bare number."""
        result = self._fn(
            "codex", 99,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn("agentrail run issue 99", result)

    def test_agentrail_run_issue_substitution_claude(self):
        result = self._fn(
            "claude", 99,
            header="H\n", skill_block="S\n",
            context_summary="CS", context_snippets="CP",
        )
        self.assertIn("agentrail run issue 99", result)


class IssueRunPhasePromptTests(unittest.TestCase):
    """Tests for issue_run_phase_prompt()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import issue_run_phase_prompt
        return issue_run_phase_prompt(*args, **kwargs)

    # --- plan phase ---

    def test_plan_phase_header(self):
        result = self._fn(
            "plan", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
        )
        self.assertIn("This is phase 1 of 2: plan.", result)

    def test_plan_issue_context(self):
        result = self._fn(
            "plan", 7,
            issue_context="my issue context", base_prompt="BP", context_summary="CS",
        )
        self.assertIn("Issue context:", result)
        self.assertIn("my issue context", result)

    def test_plan_context_pack(self):
        result = self._fn(
            "plan", 7,
            issue_context="IC", base_prompt="BP", context_summary="my summary",
        )
        self.assertIn("Phase context pack:", result)
        self.assertIn("my summary", result)

    def test_plan_base_ralph_instructions(self):
        result = self._fn(
            "plan", 7,
            issue_context="IC", base_prompt="my base", context_summary="CS",
        )
        self.assertIn("Base Ralph instructions:", result)
        self.assertIn("my base", result)

    def test_plan_seven_headings(self):
        result = self._fn(
            "plan", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
        )
        for heading in [
            "- Goal",
            "- Non-goals",
            "- Acceptance criteria mapping",
            "- Expected files/areas",
            "- Required skills",
            "- Verification commands",
            "- Risks",
        ]:
            self.assertIn(heading, result)

    def test_plan_do_not_edit(self):
        result = self._fn(
            "plan", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
        )
        self.assertIn("Do not edit files in this phase.", result)

    # --- execute phase (no findings) ---

    def test_execute_phase_header(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
            plan_output="my plan",
        )
        self.assertIn("This is phase 2 of 2: execute.", result)

    def test_execute_attempt_line(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
            execution_attempt=2, max_execution_attempts=5,
        )
        self.assertIn("Execution attempt: 2 of 5.", result)

    def test_execute_plan_output_present(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
            plan_output="approved plan text",
        )
        self.assertIn("approved plan text", result)

    def test_execute_agentrail_invoke_line(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
        )
        self.assertIn(
            "AgentRail will invoke the Ralph one-issue executor for this phase",
            result,
        )

    def test_execute_no_findings_no_verifier_section(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
        )
        self.assertNotIn("Verifier findings", result)

    def test_execute_no_findings_blank_line_spacing(self):
        """Verify legacy 3-blank-line spacing in execute prompt (no findings).

        Legacy $(if...fi) empty slot expands to "", leaving 3 blank lines
        between base_prompt and the AgentRail invocation line.
        """
        result = self._fn(
            "execute", 7,
            issue_context="ctx",
            base_prompt="BASE",
            context_summary="SUM",
            plan_output="PLAN",
            execution_attempt=1,
            max_execution_attempts=2,
        )
        # 4 newlines = 3 blank lines between "BASE" and "AgentRail will invoke"
        self.assertIn("BASE\n\n\n\nAgentRail will invoke the Ralph one-issue executor", result)

    # --- execute phase (with findings) ---

    def test_execute_with_findings_section_header(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
            verifier_findings_text="missing test for X",
        )
        self.assertIn("Verifier findings from previous failed verify attempt:", result)

    def test_execute_with_findings_content(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
            verifier_findings_text="missing test for X",
        )
        self.assertIn("missing test for X", result)

    def test_execute_with_findings_use_line(self):
        result = self._fn(
            "execute", 7,
            issue_context="IC", base_prompt="BP", context_summary="CS",
            verifier_findings_text="missing test for X",
        )
        self.assertIn(
            "Use these findings as focused input for this execute attempt. "
            "Address only the issue-scoped gaps needed to make verification pass.",
            result,
        )

    # --- plan output truncation ---

    def test_execute_plan_output_truncation(self):
        long_plan = "x" * 100
        with patch.dict(os.environ, {"AGENTRAIL_PHASE_INLINE_MAX_CHARS": "20"}):
            result = self._fn(
                "execute", 7,
                issue_context="IC", base_prompt="BP", context_summary="CS",
                plan_output=long_plan,
            )
        self.assertIn("AgentRail truncated approved plan output", result)

    # --- unknown phase ---

    def test_unknown_phase_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            self._fn(
                "review", 7,
                issue_context="IC", base_prompt="BP", context_summary="CS",
            )
        self.assertIn("unknown issue run phase: review", str(ctx.exception))


class GrillPromptTests(unittest.TestCase):
    """Tests for grill_prompt()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import grill_prompt
        return grill_prompt(*args, **kwargs)

    def test_codex_contains_header(self):
        result = self._fn("codex", "my idea", header="HDR\n")
        self.assertIn("HDR", result)

    def test_codex_skill_line(self):
        result = self._fn("codex", "my idea", header="HDR\n")
        self.assertIn("Use the repo-local skill 'grill-with-docs'.", result)

    def test_codex_idea_substituted(self):
        result = self._fn("codex", "my idea", header="HDR\n")
        self.assertIn("my idea", result)

    def test_codex_stress_test_line(self):
        result = self._fn("codex", "my idea", header="HDR\n")
        self.assertIn("Stress-test this idea before any PRD or implementation work:", result)

    def test_codex_do_not_write_code(self):
        result = self._fn("codex", "my idea", header="HDR\n")
        self.assertIn("Do not write implementation code.", result)

    def test_claude_contains_header(self):
        result = self._fn("claude", "my idea", header="HDR\n")
        self.assertIn("HDR", result)

    def test_claude_first_line(self):
        result = self._fn("claude", "my idea", header="HDR\n")
        self.assertIn(
            "Use Claude Code to run a grill-with-docs style planning pass.",
            result,
        )

    def test_claude_idea_substituted(self):
        result = self._fn("claude", "my idea", header="HDR\n")
        self.assertIn("my idea", result)

    def test_claude_stress_test_line(self):
        result = self._fn("claude", "my idea", header="HDR\n")
        self.assertIn("Stress-test this idea before any PRD or implementation work:", result)

    def test_claude_do_not_write_code(self):
        result = self._fn("claude", "my idea", header="HDR\n")
        self.assertIn("Do not write implementation code.", result)

    def test_header_appears_first(self):
        result = self._fn("codex", "idea", header="HDR\n")
        self.assertTrue(result.startswith("HDR\n"))

    def test_unknown_agent_uses_claude_block(self):
        result = self._fn("gpt-4o", "idea", header="HDR\n")
        self.assertIn("Use Claude Code to run a grill-with-docs style planning pass.", result)

    def test_codex_no_skill_md_reference(self):
        # codex block does not mention SKILL.md read instruction (claude block does)
        result = self._fn("codex", "idea", header="HDR\n")
        self.assertNotIn("SKILL.md exists", result)

    def test_claude_skill_md_reference(self):
        result = self._fn("claude", "idea", header="HDR\n")
        self.assertIn("skills/grill-with-docs/SKILL.md", result)


class ReviewPromptTests(unittest.TestCase):
    """Tests for review_prompt()."""

    def _fn(self, *args, **kwargs):
        from agentrail.run.prompts import review_prompt
        return review_prompt(*args, **kwargs)

    def _make(self, agent="codex", pr=7):
        return self._fn(
            agent, pr,
            header="HDR\n",
            context_summary="SUM",
            context_snippets="SNIP",
        )

    def test_codex_contains_header(self):
        result = self._make()
        self.assertIn("HDR", result)

    def test_codex_contains_summary(self):
        result = self._make()
        self.assertIn("SUM", result)

    def test_codex_contains_snippets(self):
        result = self._make()
        self.assertIn("SNIP", result)

    def test_codex_first_task_line(self):
        result = self._make("codex", 7)
        self.assertIn("Review exactly one pull request: #7.", result)

    def test_codex_review_only_limit(self):
        result = self._make("codex", 7)
        self.assertIn("Review only PR #7.", result)

    def test_codex_do_not_edit(self):
        result = self._make("codex", 7)
        self.assertIn(
            "Do not edit files, commit, push, close, or merge anything.", result
        )

    def test_claude_first_task_line(self):
        result = self._make("claude", 7)
        self.assertIn("Use Claude Code to review exactly one pull request: #7.", result)

    def test_claude_review_only_limit(self):
        result = self._make("claude", 7)
        self.assertIn("Review only PR #7.", result)

    def test_claude_do_not_edit(self):
        result = self._make("claude", 7)
        self.assertIn(
            "Do not edit files, commit, push, close, or merge anything.", result
        )

    def test_no_skill_resolution_text(self):
        result = self._make("codex", 7)
        self.assertNotIn("Resolved AgentRail skills:", result)

    def test_pr_number_substitution(self):
        result = self._make("codex", 42)
        self.assertIn("#42", result)
        self.assertNotIn("#7", result)

    def test_header_appears_first(self):
        result = self._make()
        self.assertTrue(result.startswith("HDR\n"))

    def test_summary_before_snippets(self):
        result = self._make()
        self.assertLess(result.index("SUM"), result.index("SNIP"))

    def test_unknown_agent_uses_claude_block(self):
        result = self._fn(
            "gpt-4o", 7,
            header="HDR\n",
            context_summary="SUM",
            context_snippets="SNIP",
        )
        self.assertIn("Use Claude Code to review exactly one pull request: #7.", result)

    def test_assembly_order(self):
        """header + summary + \\n\\n + snippets + \\n\\n + task block"""
        result = self._fn(
            "codex", 5,
            header="HDR\n",
            context_summary="SUM",
            context_snippets="SNIP",
        )
        idx_hdr = result.index("HDR")
        idx_sum = result.index("SUM")
        idx_snip = result.index("SNIP")
        idx_task = result.index("Review exactly one pull request: #5.")
        self.assertLess(idx_hdr, idx_sum)
        self.assertLess(idx_sum, idx_snip)
        self.assertLess(idx_snip, idx_task)


if __name__ == "__main__":
    unittest.main()
