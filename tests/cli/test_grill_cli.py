"""Unit tests for `agentrail grill-me` CLI command and its main.py routing."""
from __future__ import annotations

import unittest
from io import StringIO
from unittest.mock import MagicMock, patch

import agentrail.cli.commands.grill as grill_mod
from agentrail.cli.commands.grill import run_grill
from agentrail.cli.main import main as cli_main


def _run(args, *, session=None, agent="claude", command="claude -p --dangerously-skip-permissions"):
    out, err = StringIO(), StringIO()
    sess_mock = session or MagicMock(return_value=0)
    with patch.object(grill_mod, "run_skill_session", sess_mock), \
         patch.object(grill_mod, "resolve_agent_name", MagicMock(return_value=agent)), \
         patch.object(grill_mod, "resolve_agent_command", MagicMock(return_value=command)), \
         patch("sys.stdout", out), patch("sys.stderr", err):
        rc = run_grill(args)
    return rc, out.getvalue(), err.getvalue(), sess_mock


class GrillUsageTests(unittest.TestCase):
    def test_help(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_grill(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("grill-me", out.getvalue())

    def test_unknown_option(self):
        rc, _, err, _ = _run(["--bogus"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown option", err)

    def test_agent_validation(self):
        rc, _, err, _ = _run(["--agent", "nope"])
        self.assertEqual(rc, 2)
        self.assertIn("--agent", err)

    def test_two_plans_rejected(self):
        rc, _, err, _ = _run(["a", "b"])
        self.assertEqual(rc, 2)


class GrillDispatchTests(unittest.TestCase):
    def test_binds_grill_skill_and_taste_context(self):
        rc, _, _, sess = _run(["docs/plan.md"])
        self.assertEqual(rc, 0)
        sess.assert_called_once()
        pos, kw = sess.call_args[0], sess.call_args[1]
        self.assertEqual(pos[0], "grill-with-docs")
        self.assertEqual(pos[2], ["docs/plan.md"])  # input_refs
        self.assertEqual(kw["extra_context"], ["TASTE.md"])
        self.assertFalse(kw["headless"])  # interactive by default (AC1)

    def test_no_plan_arg_passes_empty_refs(self):
        rc, _, _, sess = _run([])
        self.assertEqual(rc, 0)
        self.assertEqual(sess.call_args[0][2], [])

    def test_headless_flag(self):
        rc, _, _, sess = _run(["--headless"])
        self.assertTrue(sess.call_args[1]["headless"])

    def test_yes_alias(self):
        rc, _, _, sess = _run(["--yes"])
        self.assertTrue(sess.call_args[1]["headless"])

    def test_returns_session_exit_code(self):
        sess = MagicMock(return_value=42)
        rc, _, _, _ = _run([], session=sess)
        self.assertEqual(rc, 42)

    def test_agent_passed_through(self):
        rc, _, _, sess = _run(["--agent", "codex"], agent="codex")
        self.assertEqual(sess.call_args[1]["agent"], "codex")


class GrillRoutingTests(unittest.TestCase):
    def test_main_routes_grill_me(self):
        with patch("agentrail.cli.main.run_grill", MagicMock(return_value=0)) as m:
            rc = cli_main(["grill-me", "plan.md"])
        self.assertEqual(rc, 0)
        m.assert_called_once_with(["plan.md"])

    def test_usage_lists_grill_me(self):
        out = StringIO()
        with patch("sys.stdout", out):
            cli_main([])
        self.assertIn("grill-me", out.getvalue())


if __name__ == "__main__":
    unittest.main()
