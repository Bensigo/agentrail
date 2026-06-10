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


if __name__ == "__main__":
    unittest.main()
