"""Unit tests for `agentrail milestone create` CLI command and its main.py routing."""
from __future__ import annotations

import os
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import agentrail.cli.commands.milestone as milestone_mod
from agentrail.cli.commands.milestone import (
    _next_milestone_number,
    _slug_from_ref,
    run_milestone,
)
from agentrail.cli.main import main as cli_main


def _run(
    args,
    *,
    session=None,
    agent="claude",
    command="claude -p --dangerously-skip-permissions",
):
    out, err = StringIO(), StringIO()
    sess_mock = session or MagicMock(return_value=0)
    with (
        patch.object(milestone_mod, "run_skill_session", sess_mock),
        patch.object(milestone_mod, "resolve_agent_name", MagicMock(return_value=agent)),
        patch.object(milestone_mod, "resolve_agent_command", MagicMock(return_value=command)),
        patch.object(milestone_mod, "ensure_command_available", MagicMock()),
        patch("sys.stdout", out),
        patch("sys.stderr", err),
    ):
        rc = run_milestone(args)
    return rc, out.getvalue(), err.getvalue(), sess_mock


class MilestoneUsageTests(unittest.TestCase):
    def test_no_args_prints_usage(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_milestone([])
        self.assertEqual(rc, 0)
        self.assertIn("milestone create", out.getvalue())

    def test_help_flag(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_milestone(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("milestone create", out.getvalue())

    def test_unknown_subcommand(self):
        _, _, err, _ = _run(["bogus"])
        # should print error and return 2
        rc, _, err2, _ = _run(["bogus"])
        self.assertIn("Unknown milestone subcommand", err2)

    def test_unknown_subcommand_returns_2(self):
        rc, _, _, _ = _run(["bogus"])
        self.assertEqual(rc, 2)

    def test_create_help(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_milestone(["create", "-h"])
        self.assertEqual(rc, 0)
        self.assertIn("to-milestones", out.getvalue())

    def test_create_no_prd_returns_error(self):
        rc, _, err, _ = _run(["create"])
        self.assertEqual(rc, 2)
        self.assertIn("<prd>", err)

    def test_create_unknown_option(self):
        rc, _, err, _ = _run(["create", "--bogus", "prd.md"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown option", err)

    def test_create_agent_validation(self):
        rc, _, err, _ = _run(["create", "--agent", "nope", "prd.md"])
        self.assertEqual(rc, 2)
        self.assertIn("--agent", err)

    def test_create_two_prds_rejected(self):
        rc, _, err, _ = _run(["create", "a.md", "b.md"])
        self.assertEqual(rc, 2)


class MilestoneDryRunTests(unittest.TestCase):
    def test_dry_run_prints_would_write(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out = StringIO()
            with patch("sys.stdout", out), patch("os.getcwd", return_value=tmpdir):
                rc = run_milestone(["create", "docs/my-prd.md", "--dry-run"])
            self.assertEqual(rc, 0)
            self.assertIn("Would write", out.getvalue())
            self.assertIn("001-my-prd.md", out.getvalue())

    def test_dry_run_does_not_invoke_session(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            sess = MagicMock()
            with (
                patch.object(milestone_mod, "run_skill_session", sess),
                patch("os.getcwd", return_value=tmpdir),
                patch("sys.stdout", StringIO()),
            ):
                run_milestone(["create", "prd.md", "--dry-run"])
            sess.assert_not_called()

    def test_dry_run_numbering_next_free(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ms_dir = Path(tmpdir) / "docs" / "milestones"
            ms_dir.mkdir(parents=True)
            (ms_dir / "001-alpha.md").write_text("# M1")
            (ms_dir / "002-beta.md").write_text("# M2")
            out = StringIO()
            with patch("sys.stdout", out), patch("os.getcwd", return_value=tmpdir):
                rc = run_milestone(["create", "prd.md", "--dry-run"])
            self.assertEqual(rc, 0)
            self.assertIn("003-", out.getvalue())

    def test_dry_run_no_milestones_dir_starts_at_001(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out = StringIO()
            with patch("sys.stdout", out), patch("os.getcwd", return_value=tmpdir):
                run_milestone(["create", "prd.md", "--dry-run"])
            self.assertIn("001-", out.getvalue())

    def test_dry_run_does_not_create_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ms_dir = Path(tmpdir) / "docs" / "milestones"
            with patch("sys.stdout", StringIO()), patch("os.getcwd", return_value=tmpdir):
                run_milestone(["create", "prd.md", "--dry-run"])
            self.assertFalse(ms_dir.exists())


class MilestoneNextNumberTests(unittest.TestCase):
    def test_empty_dir_returns_1(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ms_dir = Path(tmpdir) / "docs" / "milestones"
            ms_dir.mkdir(parents=True)
            self.assertEqual(_next_milestone_number(Path(tmpdir)), 1)

    def test_missing_dir_returns_1(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self.assertEqual(_next_milestone_number(Path(tmpdir)), 1)

    def test_picks_next_after_highest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ms_dir = Path(tmpdir) / "docs" / "milestones"
            ms_dir.mkdir(parents=True)
            (ms_dir / "001-foo.md").write_text("")
            (ms_dir / "003-bar.md").write_text("")  # gap: no 002
            self.assertEqual(_next_milestone_number(Path(tmpdir)), 4)

    def test_ignores_non_matching_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ms_dir = Path(tmpdir) / "docs" / "milestones"
            ms_dir.mkdir(parents=True)
            (ms_dir / "README.md").write_text("")
            (ms_dir / "001-first.md").write_text("")
            self.assertEqual(_next_milestone_number(Path(tmpdir)), 2)


class MilestoneSlugTests(unittest.TestCase):
    def test_slug_from_path(self):
        self.assertEqual(_slug_from_ref("docs/my-prd.md"), "my-prd")

    def test_slug_from_spec_path(self):
        result = _slug_from_ref("docs/superpowers/specs/2026-06-11-skill-backed.md")
        self.assertEqual(result, "2026-06-11-skill-backed")

    def test_slug_lowercases(self):
        self.assertEqual(_slug_from_ref("MyPRD.md"), "myprd")

    def test_slug_replaces_special_chars(self):
        self.assertEqual(_slug_from_ref("foo bar_baz.md"), "foo-bar-baz")

    def test_slug_fallback_on_empty(self):
        self.assertEqual(_slug_from_ref("---.md"), "milestone")


class MilestoneDispatchTests(unittest.TestCase):
    def test_binds_to_milestones_skill(self):
        rc, _, _, sess = _run(["create", "docs/prd.md"])
        self.assertEqual(rc, 0)
        sess.assert_called_once()
        pos = sess.call_args[0]
        self.assertEqual(pos[0], "to-milestones")

    def test_passes_prd_as_input_ref(self):
        rc, _, _, sess = _run(["create", "docs/prd.md"])
        pos = sess.call_args[0]
        self.assertEqual(pos[2], ["docs/prd.md"])

    def test_extra_context_includes_taste(self):
        rc, _, _, sess = _run(["create", "docs/prd.md"])
        kw = sess.call_args[1]
        self.assertEqual(kw["extra_context"], ["TASTE.md"])

    def test_interactive_by_default(self):
        rc, _, _, sess = _run(["create", "docs/prd.md"])
        kw = sess.call_args[1]
        self.assertFalse(kw["headless"])

    def test_headless_flag(self):
        rc, _, _, sess = _run(["create", "docs/prd.md", "--headless"])
        self.assertTrue(sess.call_args[1]["headless"])

    def test_yes_alias_for_headless(self):
        rc, _, _, sess = _run(["create", "docs/prd.md", "--yes"])
        self.assertTrue(sess.call_args[1]["headless"])

    def test_agent_passed_through(self):
        rc, _, _, sess = _run(["create", "docs/prd.md", "--agent", "codex"], agent="codex")
        self.assertEqual(sess.call_args[1]["agent"], "codex")

    def test_returns_session_exit_code(self):
        sess = MagicMock(return_value=42)
        rc, _, _, _ = _run(["create", "docs/prd.md"], session=sess)
        self.assertEqual(rc, 42)

    def test_ensure_command_available_called(self):
        with (
            patch.object(milestone_mod, "run_skill_session", MagicMock(return_value=0)),
            patch.object(milestone_mod, "resolve_agent_name", MagicMock(return_value="claude")),
            patch.object(milestone_mod, "resolve_agent_command", MagicMock(return_value="claude -p")),
            patch.object(milestone_mod, "ensure_command_available") as eca,
        ):
            run_milestone(["create", "prd.md"])
        eca.assert_called_once_with("claude -p")


class MilestoneRoutingTests(unittest.TestCase):
    def test_main_routes_milestone(self):
        with patch("agentrail.cli.main.run_milestone", MagicMock(return_value=0)) as m:
            rc = cli_main(["milestone", "create", "prd.md"])
        self.assertEqual(rc, 0)
        m.assert_called_once_with(["create", "prd.md"])

    def test_usage_lists_milestone_create(self):
        out = StringIO()
        with patch("sys.stdout", out):
            cli_main([])
        self.assertIn("milestone", out.getvalue())
        self.assertIn("milestone create", out.getvalue())


if __name__ == "__main__":
    unittest.main()
