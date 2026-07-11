"""Unit tests for `agentrail prompt` CLI command (agentrail/cli/commands/prompt.py).

All external I/O is patched so these tests run without gh, skills registry, or a
real repo.
"""
from __future__ import annotations

import sys
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import agentrail.cli.commands.prompt as prompt_mod
from agentrail.cli.commands.prompt import run_prompt
from agentrail.run.skills import SkillResolutionError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(args, *, patches=None):
    """Run run_prompt(args) with optional extra patches dict.
    Returns (rc, stdout, stderr).
    """
    extra = patches or {}
    # Always patch the infrastructure
    base_patches = {
        "agentrail.cli.commands.prompt.render_state_summary": MagicMock(return_value="STATE"),
        "agentrail.cli.commands.prompt.common_header": MagicMock(return_value="HDR\n"),
        "agentrail.cli.commands.prompt._repo_dir": MagicMock(return_value=Path("/repo")),
    }
    base_patches.update(extra)

    out = StringIO()
    err = StringIO()
    with patch.multiple("agentrail.cli.commands.prompt", **{
        k.replace("agentrail.cli.commands.prompt.", ""): v
        for k, v in base_patches.items()
        if k.startswith("agentrail.cli.commands.prompt.")
    }):
        with patch("sys.stdout", out), patch("sys.stderr", err):
            rc = run_prompt(args)
    return rc, out.getvalue(), err.getvalue()


def _p(name, return_value=None, side_effect=None):
    """Shorthand patch key → MagicMock."""
    m = MagicMock()
    if side_effect is not None:
        m.side_effect = side_effect
    elif return_value is not None:
        m.return_value = return_value
    return (name, m)


# ---------------------------------------------------------------------------
# Use a simpler direct-patching approach
# ---------------------------------------------------------------------------

class PromptHelpAndUsageTests(unittest.TestCase):
    def _run(self, args):
        out = StringIO(); err = StringIO()
        with patch("sys.stdout", out), patch("sys.stderr", err):
            rc = run_prompt(args)
        return rc, out.getvalue(), err.getvalue()

    def test_help_short(self):
        rc, out, _ = self._run(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", out)

    def test_help_long(self):
        rc, out, _ = self._run(["--help"])
        self.assertEqual(rc, 0)
        self.assertIn("Usage", out)

    def test_empty_args_rc1_stderr(self):
        rc, out, err = self._run([])
        self.assertEqual(rc, 1)
        self.assertIn("Usage", err)

    def test_unknown_kind_rc2(self):
        rc, out, err = self._run(["bogus", "1"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown prompt type: bogus", err)

    def test_no_subject_rc2(self):
        rc, out, err = self._run(["issue"])
        self.assertEqual(rc, 2)
        self.assertIn("prompt issue requires an argument", err)

    def test_subject_is_flag_rc2(self):
        rc, out, err = self._run(["issue", "--target", "/x"])
        self.assertEqual(rc, 2)
        self.assertIn("prompt issue requires an argument", err)

    def test_issue_non_numeric_rc2(self):
        rc, out, err = self._run(["issue", "abc"])
        self.assertEqual(rc, 2)
        self.assertIn("prompt issue argument must be numeric", err)

    def test_review_non_numeric_rc2(self):
        rc, out, err = self._run(["review", "abc"])
        self.assertEqual(rc, 2)
        self.assertIn("prompt review argument must be numeric", err)

    def test_bad_agent_rc2(self):
        rc, out, err = self._run(["issue", "7", "--agent", "bad"])
        self.assertEqual(rc, 2)
        self.assertIn("--agent must be codex or claude", err)

    def test_unknown_option_rc2(self):
        rc, out, err = self._run(["grill", "idea", "--unknown-flag"])
        self.assertEqual(rc, 2)


class PromptGrillTests(unittest.TestCase):
    def _base_patches(self):
        return {
            "render_state_summary": MagicMock(return_value="STATE"),
            "common_header": MagicMock(return_value="HDR\n"),
            "_repo_dir": MagicMock(return_value=Path("/repo")),
            "grill_prompt": MagicMock(return_value="GRILL OUT"),
        }

    def test_grill_basic(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["grill", "my idea"])
        self.assertEqual(rc, 0)
        self.assertIn("GRILL OUT", out.getvalue())
        patches["grill_prompt"].assert_called_once_with(
            "codex", "my idea", header="HDR\n"
        )

    def test_grill_agent_claude(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["grill", "idea", "--agent", "claude"])
        self.assertEqual(rc, 0)
        patches["grill_prompt"].assert_called_once_with(
            "claude", "idea", header="HDR\n"
        )

    def test_grill_with_skills_flags_no_error(self):
        """Skills flags parse without error even though grill doesn't use them."""
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(
                    ["grill", "idea", "--no-auto-skills", "--skill", "tdd", "--skill", "foo"]
                )
        self.assertEqual(rc, 0)

    def test_grill_multiword_subject(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["grill", "my idea"])
        self.assertEqual(rc, 0)
        patches["grill_prompt"].assert_called_once()
        _, posargs, _ = patches["grill_prompt"].mock_calls[0]
        self.assertEqual(posargs[1], "my idea")


class PromptIssueTests(unittest.TestCase):
    def _base_patches(self):
        return {
            "render_state_summary": MagicMock(return_value="STATE"),
            "common_header": MagicMock(return_value="HDR\n"),
            "_repo_dir": MagicMock(return_value=Path("/repo")),
            "issue_resolution_text": MagicMock(return_value="T"),
            "resolve_skills": MagicMock(return_value={"resolved": [], "autoSkills": True}),
            "build_issue_context_pack": MagicMock(return_value="p.json"),
            "context_pack_summary": MagicMock(return_value="SUM"),
            "context_selected_snippets": MagicMock(return_value="SNIP"),
            "format_skill_resolution": MagicMock(return_value="SKILLS"),
            "issue_base_prompt": MagicMock(return_value="ISSUE OUT"),
        }

    def test_issue_basic(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["issue", "7"])
        self.assertEqual(rc, 0)
        self.assertIn("ISSUE OUT", out.getvalue())
        patches["issue_base_prompt"].assert_called_once()
        call_kwargs = patches["issue_base_prompt"].call_args
        # positional: agent, issue
        self.assertEqual(call_kwargs[0][0], "codex")
        self.assertEqual(call_kwargs[0][1], 7)

    def test_issue_skill_resolution_error_rc1(self):
        patches = self._base_patches()
        patches["resolve_skills"].side_effect = SkillResolutionError("bad skill")
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["issue", "7"])
        self.assertEqual(rc, 1)
        self.assertIn("bad skill", err.getvalue())

    def test_issue_resolve_skills_generic_exception_continues(self):
        """Generic exception from resolve_skills falls back gracefully, still rc 0."""
        patches = self._base_patches()
        patches["resolve_skills"].side_effect = RuntimeError("network down")
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["issue", "7"])
        self.assertEqual(rc, 0)
        self.assertIn("ISSUE OUT", out.getvalue())

    def test_issue_build_pack_called_with_plan(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                run_prompt(["issue", "7"])
        patches["build_issue_context_pack"].assert_called_once()
        call_args = patches["build_issue_context_pack"].call_args
        # phase should be "plan"
        self.assertEqual(call_args[0][2], "plan")


class PromptReviewTests(unittest.TestCase):
    def _base_patches(self):
        return {
            "render_state_summary": MagicMock(return_value="STATE"),
            "common_header": MagicMock(return_value="HDR\n"),
            "_repo_dir": MagicMock(return_value=Path("/repo")),
            "build_pack": MagicMock(return_value="pr.json"),
            "context_pack_summary": MagicMock(return_value="SUM"),
            "context_selected_snippets": MagicMock(return_value="SNIP"),
            "review_prompt": MagicMock(return_value="REVIEW OUT"),
        }

    def test_review_basic(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                rc = run_prompt(["review", "9"])
        self.assertEqual(rc, 0)
        self.assertIn("REVIEW OUT", out.getvalue())
        patches["review_prompt"].assert_called_once()
        call_args = patches["review_prompt"].call_args
        self.assertEqual(call_args[0][0], "codex")
        self.assertEqual(call_args[0][1], 9)

    def test_review_build_pack_kind_pr(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                run_prompt(["review", "9"])
        patches["build_pack"].assert_called_once()
        call_args = patches["build_pack"].call_args
        # positional: target, kind, number, phase
        self.assertEqual(call_args[0][1], "pr")
        self.assertEqual(call_args[0][2], 9)
        self.assertEqual(call_args[0][3], "review")

    def test_review_context_snippets_query(self):
        patches = self._base_patches()
        out = StringIO(); err = StringIO()
        with patch.multiple("agentrail.cli.commands.prompt", **patches):
            with patch("sys.stdout", out), patch("sys.stderr", err):
                run_prompt(["review", "9"])
        patches["context_selected_snippets"].assert_called_once()
        snippet_call = patches["context_selected_snippets"].call_args
        # query should mention "review pr 9"
        self.assertIn("9", snippet_call[0][1])


class PromptMainRoutingTests(unittest.TestCase):
    def test_main_routes_prompt(self):
        import agentrail.cli.main as m
        with patch.object(m, "run_prompt", return_value=0) as mock_rp:
            rc = m.main(["prompt", "issue", "7"])
        mock_rp.assert_called_once_with(["issue", "7"])
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
