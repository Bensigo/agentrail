"""Unit tests for `agentrail prd create` CLI command and its main.py routing."""
from __future__ import annotations

import unittest
from io import StringIO
from unittest.mock import MagicMock, patch

import agentrail.cli.commands.prd as prd_mod
from agentrail.cli.commands.prd import run_prd
from agentrail.cli.main import main as cli_main


def _run(
    args,
    *,
    session=None,
    agent="claude",
    command="claude --dangerously-skip-permissions",
):
    out, err = StringIO(), StringIO()
    sess_mock = session or MagicMock(return_value=0)
    with (
        patch.object(prd_mod, "run_skill_session", sess_mock),
        patch.object(prd_mod, "resolve_agent_name", MagicMock(return_value=agent)),
        patch.object(prd_mod, "resolve_agent_command", MagicMock(return_value=command)),
        patch.object(prd_mod, "ensure_command_available", MagicMock()),
        patch("sys.stdout", out),
        patch("sys.stderr", err),
    ):
        rc = run_prd(args)
    return rc, out.getvalue(), err.getvalue(), sess_mock


class PrdUsageTests(unittest.TestCase):
    def test_no_args_prints_usage(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_prd([])
        self.assertEqual(rc, 0)
        self.assertIn("prd create", out.getvalue())

    def test_help_flag(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_prd(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("prd create", out.getvalue())

    def test_unknown_subcommand_returns_2(self):
        rc, _, err, _ = _run(["bogus"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown prd subcommand", err)

    def test_create_help(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_prd(["create", "-h"])
        self.assertEqual(rc, 0)
        self.assertIn("to-prd", out.getvalue())

    def test_create_no_brief_returns_error(self):
        rc, _, err, _ = _run(["create"])
        self.assertEqual(rc, 2)
        self.assertIn("<brief>", err)

    def test_create_unknown_option(self):
        rc, _, err, _ = _run(["create", "--bogus", "my idea"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown option", err)

    def test_create_agent_validation(self):
        rc, _, err, _ = _run(["create", "--agent", "nope", "my idea"])
        self.assertEqual(rc, 2)
        self.assertIn("--agent", err)

    def test_create_two_briefs_rejected(self):
        rc, _, err, _ = _run(["create", "idea one", "idea two"])
        self.assertEqual(rc, 2)


class PrdDryRunTests(unittest.TestCase):
    def test_dry_run_prints_would_publish(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_prd(["create", "Add dark mode toggle", "--dry-run"])
        self.assertEqual(rc, 0)
        self.assertIn("Would publish PRD", out.getvalue())
        self.assertIn("ready-for-agent", out.getvalue())

    def test_dry_run_prints_seed_prompt_components(self):
        out = StringIO()
        with patch("sys.stdout", out):
            run_prd(["create", "Add dark mode toggle", "--dry-run"])
        output = out.getvalue()
        self.assertIn("apps/jace/agent/skills/to-prd/SKILL.md", output)
        self.assertIn("CONTEXT.md", output)
        self.assertIn("TASTE.md", output)
        self.assertIn("Add dark mode toggle", output)

    def test_dry_run_documents_no_local_file(self):
        out = StringIO()
        with patch("sys.stdout", out):
            run_prd(["create", "some idea", "--dry-run"])
        output = out.getvalue()
        # Assert the negative policy explicitly, not just incidental presence of
        # the path fragment in some sentence.
        self.assertIn("No local", output)
        self.assertIn("docs/prd/", output)

    def test_dry_run_does_not_invoke_session(self):
        sess = MagicMock()
        with (
            patch.object(prd_mod, "run_skill_session", sess),
            patch("sys.stdout", StringIO()),
        ):
            run_prd(["create", "some idea", "--dry-run"])
        sess.assert_not_called()

    def test_dry_run_does_not_call_ensure_command(self):
        eca = MagicMock()
        with (
            patch.object(prd_mod, "run_skill_session", MagicMock()),
            patch.object(prd_mod, "ensure_command_available", eca),
            patch("sys.stdout", StringIO()),
        ):
            run_prd(["create", "some idea", "--dry-run"])
        eca.assert_not_called()


class PrdDispatchTests(unittest.TestCase):
    def test_binds_to_prd_skill(self):
        rc, _, _, sess = _run(["create", "Add dark mode"])
        self.assertEqual(rc, 0)
        sess.assert_called_once()
        pos = sess.call_args[0]
        self.assertEqual(pos[0], "to-prd")

    def test_passes_brief_as_input_ref(self):
        rc, _, _, sess = _run(["create", "Add dark mode"])
        pos = sess.call_args[0]
        self.assertEqual(pos[2], ["Add dark mode"])

    def test_extra_context_includes_taste(self):
        rc, _, _, sess = _run(["create", "Add dark mode"])
        kw = sess.call_args[1]
        self.assertEqual(kw["extra_context"], ["TASTE.md"])

    def test_interactive_by_default(self):
        rc, _, _, sess = _run(["create", "Add dark mode"])
        kw = sess.call_args[1]
        self.assertFalse(kw["headless"])

    def test_headless_flag(self):
        rc, _, _, sess = _run(["create", "Add dark mode", "--headless"])
        self.assertTrue(sess.call_args[1]["headless"])

    def test_yes_alias_for_headless(self):
        rc, _, _, sess = _run(["create", "Add dark mode", "--yes"])
        self.assertTrue(sess.call_args[1]["headless"])

    def test_agent_passed_through(self):
        rc, _, _, sess = _run(["create", "Add dark mode", "--agent", "codex"], agent="codex")
        self.assertEqual(sess.call_args[1]["agent"], "codex")

    def test_returns_session_exit_code(self):
        sess = MagicMock(return_value=42)
        rc, _, _, _ = _run(["create", "Add dark mode"], session=sess)
        self.assertEqual(rc, 42)

    def test_ensure_command_available_called(self):
        with (
            patch.object(prd_mod, "run_skill_session", MagicMock(return_value=0)),
            patch.object(prd_mod, "resolve_agent_name", MagicMock(return_value="claude")),
            patch.object(prd_mod, "resolve_agent_command", MagicMock(return_value="claude --dangerously-skip-permissions")),
            patch.object(prd_mod, "ensure_command_available") as eca,
        ):
            run_prd(["create", "some idea"])
        eca.assert_called_once_with("claude --dangerously-skip-permissions")

    def test_brief_as_file_path_accepted(self):
        rc, _, _, sess = _run(["create", "docs/my-idea.md"])
        self.assertEqual(rc, 0)
        pos = sess.call_args[0]
        self.assertEqual(pos[2], ["docs/my-idea.md"])


class PrdRoutingTests(unittest.TestCase):
    def test_main_routes_prd(self):
        with patch("agentrail.cli.main.run_prd", MagicMock(return_value=0)) as m:
            rc = cli_main(["prd", "create", "Add dark mode"])
        self.assertEqual(rc, 0)
        m.assert_called_once_with(["create", "Add dark mode"])

    def test_usage_lists_prd_create(self):
        out = StringIO()
        with patch("sys.stdout", out):
            cli_main([])
        output = out.getvalue()
        self.assertIn("prd", output)
        self.assertIn("prd create", output)


if __name__ == "__main__":
    unittest.main()
