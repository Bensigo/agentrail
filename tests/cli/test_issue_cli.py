"""Unit tests for ``agentrail issue create`` CLI command and main.py routing."""
from __future__ import annotations

import tempfile
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import agentrail.cli.commands.issue as issue_mod
from agentrail.cli.commands.issue import (
    EXTRA_CONTEXT,
    SKILL_NAME,
    TRIAGE_LABEL,
    parse_issue_bodies,
    publish_issue,
    run_issue,
)
from agentrail.cli.main import main as cli_main


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SAMPLE_BODY = """\
## Parent

docs/milestones/001-foo.md

## Required context

- `CONTEXT.md`: Domain constraints.
- `TASTE.md`: Quality requirements.

## What to build

A thin vertical slice.

## Acceptance criteria

- [ ] AC1: Observable behavior.

## Verification evidence

- `python -m pytest`

## Blocked by

None - can start immediately
"""

_SAMPLE_OUTPUT = f"""\
Here are the issues I created:

<!-- ISSUE START -->
{_SAMPLE_BODY}
<!-- ISSUE END -->

Done.
"""


def _run_create(args, *, session=None, agent="claude", command="claude -p --dangerously-skip-permissions"):
    """Run ``agentrail issue create <args>`` with mocked session + agent resolution."""
    out, err = StringIO(), StringIO()
    sess_mock = session if session is not None else MagicMock(return_value=0)
    with patch.object(issue_mod, "run_skill_session", sess_mock), \
         patch.object(issue_mod, "resolve_agent_name", MagicMock(return_value=agent)), \
         patch.object(issue_mod, "resolve_agent_command", MagicMock(return_value=command)), \
         patch.object(issue_mod, "ensure_command_available", MagicMock()), \
         patch.object(issue_mod, "_run_headless", MagicMock(return_value=0)), \
         patch("sys.stdout", out), patch("sys.stderr", err):
        rc = run_issue(["create"] + args)
    return rc, out.getvalue(), err.getvalue(), sess_mock


# ---------------------------------------------------------------------------
# parse_issue_bodies — pure unit
# ---------------------------------------------------------------------------

class ParseIssueBodiesTests(unittest.TestCase):
    def test_extracts_single_body(self):
        bodies = parse_issue_bodies(_SAMPLE_OUTPUT)
        self.assertEqual(len(bodies), 1)
        self.assertIn("## Parent", bodies[0])
        self.assertIn("AC1", bodies[0])

    def test_extracts_multiple_bodies(self):
        output = (
            "<!-- ISSUE START -->\nbody one\n<!-- ISSUE END -->\n"
            "<!-- ISSUE START -->\nbody two\n<!-- ISSUE END -->\n"
        )
        bodies = parse_issue_bodies(output)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0], "body one")
        self.assertEqual(bodies[1], "body two")

    def test_empty_markers_skipped(self):
        output = "<!-- ISSUE START -->   <!-- ISSUE END -->"
        self.assertEqual(parse_issue_bodies(output), [])

    def test_no_markers_returns_empty(self):
        self.assertEqual(parse_issue_bodies("no markers here"), [])

    def test_case_insensitive_markers(self):
        output = "<!-- issue start -->\nbody\n<!-- issue end -->"
        self.assertEqual(parse_issue_bodies(output), ["body"])

    def test_strips_leading_trailing_whitespace(self):
        output = "<!-- ISSUE START -->\n\n  trimmed  \n\n<!-- ISSUE END -->"
        self.assertEqual(parse_issue_bodies(output), ["trimmed"])


# ---------------------------------------------------------------------------
# publish_issue — unit (mock subprocess)
# ---------------------------------------------------------------------------

class PublishIssueTests(unittest.TestCase):
    def test_calls_gh_with_label_and_body(self):
        sp = MagicMock()
        sp.run.return_value = SimpleNamespace(returncode=0)
        rc = publish_issue("body text", "/tmp", sp)
        self.assertEqual(rc, 0)
        sp.run.assert_called_once()
        call_args = sp.run.call_args[0][0]
        self.assertEqual(call_args[0], "gh")
        self.assertIn("issue", call_args)
        self.assertIn("create", call_args)
        self.assertIn("--label", call_args)
        label_idx = call_args.index("--label")
        self.assertEqual(call_args[label_idx + 1], TRIAGE_LABEL)
        self.assertIn("--body", call_args)
        body_idx = call_args.index("--body")
        self.assertEqual(call_args[body_idx + 1], "body text")

    def test_forwards_nonzero_rc(self):
        sp = MagicMock()
        sp.run.return_value = SimpleNamespace(returncode=1)
        rc = publish_issue("body", "/tmp", sp)
        self.assertEqual(rc, 1)


# ---------------------------------------------------------------------------
# Usage / routing
# ---------------------------------------------------------------------------

class IssueUsageTests(unittest.TestCase):
    def test_help(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_issue(["-h"])
        self.assertEqual(rc, 0)
        self.assertIn("issue create", out.getvalue())

    def test_no_args_shows_usage(self):
        out = StringIO()
        with patch("sys.stdout", out):
            rc = run_issue([])
        self.assertEqual(rc, 0)
        self.assertIn("issue create", out.getvalue())

    def test_unknown_subcommand(self):
        err = StringIO()
        with patch("sys.stderr", err):
            rc = run_issue(["bogus"])
        self.assertEqual(rc, 2)
        self.assertIn("bogus", err.getvalue())

    def test_unknown_option(self):
        rc, _, err, _ = _run_create(["--bogus"])
        self.assertEqual(rc, 2)
        self.assertIn("Unknown option", err)

    def test_agent_validation(self):
        rc, _, err, _ = _run_create(["--agent", "nope"])
        self.assertEqual(rc, 2)
        self.assertIn("--agent", err)

    def test_two_milestone_args_rejected(self):
        rc, _, err, _ = _run_create(["a.md", "b.md"])
        self.assertEqual(rc, 2)


# ---------------------------------------------------------------------------
# Interactive path
# ---------------------------------------------------------------------------

class IssueInteractiveTests(unittest.TestCase):
    def test_interactive_calls_run_skill_session_not_headless(self):
        rc, _, _, sess = _run_create(["docs/milestones/001-foo.md"])
        self.assertEqual(rc, 0)
        sess.assert_called_once()
        kw = sess.call_args[1]
        self.assertFalse(kw["headless"])

    def test_interactive_passes_skill_name(self):
        rc, _, _, sess = _run_create(["docs/milestones/001-foo.md"])
        self.assertEqual(sess.call_args[0][0], SKILL_NAME)

    def test_interactive_passes_input_refs(self):
        rc, _, _, sess = _run_create(["docs/milestones/001-foo.md"])
        self.assertEqual(sess.call_args[0][2], ["docs/milestones/001-foo.md"])

    def test_interactive_extra_context_includes_taste_and_labels(self):
        rc, _, _, sess = _run_create(["docs/milestones/001-foo.md"])
        extra = sess.call_args[1]["extra_context"]
        self.assertIn("TASTE.md", extra)
        self.assertIn("docs/agents/triage-labels.md", extra)

    def test_interactive_empty_refs_when_no_milestone(self):
        rc, _, _, sess = _run_create([])
        self.assertEqual(sess.call_args[0][2], [])

    def test_headless_flag_sets_headless_true(self):
        rc, _, _, sess = _run_create(["--headless"])
        # headless path does NOT call run_skill_session
        sess.assert_not_called()

    def test_yes_alias_headless(self):
        rc, _, _, sess = _run_create(["--yes"])
        sess.assert_not_called()

    def test_interactive_dry_run_warns(self):
        rc, _, err, _ = _run_create(["--dry-run"])
        # dry-run without --headless → interactive with a warning
        self.assertIn("dry-run", err.lower())

    def test_returns_session_exit_code(self):
        sess = MagicMock(return_value=42)
        rc, _, _, _ = _run_create([], session=sess)
        self.assertEqual(rc, 42)


# ---------------------------------------------------------------------------
# Headless dry-run path
# ---------------------------------------------------------------------------

def _make_minimal_repo(tmp: Path, skill_body: str = "SKILL-BODY") -> Path:
    """Create a minimal repo+target structure for headless tests."""
    repo = tmp / "repo"
    (repo / "skills" / "to-issues").mkdir(parents=True)
    (repo / "skills" / "to-issues" / "SKILL.md").write_text(skill_body, encoding="utf-8")
    target = tmp / "target"
    target.mkdir()
    (target / "CONTEXT.md").write_text("# Context\n", encoding="utf-8")
    return repo


class IssueHeadlessDryRunTests(unittest.TestCase):
    def _run_headless(self, *, dry_run=True, agent_output=None, returncode=0):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = _make_minimal_repo(tmp_path)
            target = str(tmp_path / "target")

            agent_out = agent_output if agent_output is not None else _SAMPLE_OUTPUT
            sp = MagicMock()
            sp.run.return_value = SimpleNamespace(
                returncode=returncode,
                stdout=agent_out,
                stderr="",
            )

            out, err = StringIO(), StringIO()
            with patch("sys.stdout", out), patch("sys.stderr", err), \
                 patch.object(issue_mod, "sanitized_env", MagicMock(return_value={})):
                rc = issue_mod._run_headless(
                    agent="claude",
                    command="claude -p --dangerously-skip-permissions",
                    target=target,
                    input_refs=[],
                    dry_run=dry_run,
                    _subprocess=sp,
                    _repo=repo,
                )
            return rc, out.getvalue(), err.getvalue(), sp

    def test_dry_run_prints_body_not_calls_gh(self):
        rc, out, err, sp = self._run_headless(dry_run=True)
        self.assertEqual(rc, 0)
        self.assertIn("## Parent", out)
        # gh called exactly once (for the agent itself), NOT for gh issue create
        calls = sp.run.call_args_list
        for c in calls:
            cmd = c[0][0] if c[0] else c[1].get("args", [])
            self.assertNotEqual(cmd[0] if cmd else None, "gh")

    def test_dry_run_output_contains_template_sections(self):
        rc, out, _, _ = self._run_headless(dry_run=True)
        for section in ("## Parent", "## Required context", "## What to build",
                        "## Acceptance criteria", "## Verification evidence",
                        "## Blocked by"):
            self.assertIn(section, out)

    def test_agent_nonzero_rc_propagated(self):
        rc, _, _, _ = self._run_headless(returncode=1, agent_output="")
        self.assertEqual(rc, 1)

    def test_no_markers_warns_and_returns_zero(self):
        rc, out, err, _ = self._run_headless(agent_output="no markers here")
        self.assertEqual(rc, 0)
        self.assertIn("no issue bodies found", err)

    def test_headless_seed_contains_skill_body(self):
        """Agent subprocess receives a seed prompt containing the skill body."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = _make_minimal_repo(tmp_path, skill_body="UNIQUE-SKILL-CONTENT-XYZ")
            target = str(tmp_path / "target")

            sp = MagicMock()
            sp.run.return_value = SimpleNamespace(
                returncode=0, stdout=_SAMPLE_OUTPUT, stderr=""
            )
            with patch.object(issue_mod, "sanitized_env", MagicMock(return_value={})):
                issue_mod._run_headless(
                    agent="claude",
                    command="claude -p --dangerously-skip-permissions",
                    target=target,
                    input_refs=[],
                    dry_run=True,
                    _subprocess=sp,
                    _repo=repo,
                )

            seed = sp.run.call_args[1]["input"]
            self.assertIn("UNIQUE-SKILL-CONTENT-XYZ", seed)
            self.assertIn("to-issues", seed)
            self.assertIn("CONTEXT.md", seed)


# ---------------------------------------------------------------------------
# Headless publish path (no --dry-run)
# ---------------------------------------------------------------------------

class IssueHeadlessPublishTests(unittest.TestCase):
    def test_publish_calls_gh_with_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = _make_minimal_repo(tmp_path)
            target = str(tmp_path / "target")

            agent_proc = SimpleNamespace(returncode=0, stdout=_SAMPLE_OUTPUT, stderr="")
            gh_proc = SimpleNamespace(returncode=0)

            sp = MagicMock()
            sp.run.side_effect = [agent_proc, gh_proc]

            with patch.object(issue_mod, "sanitized_env", MagicMock(return_value={})):
                rc = issue_mod._run_headless(
                    agent="claude",
                    command="claude -p --dangerously-skip-permissions",
                    target=target,
                    input_refs=[],
                    dry_run=False,
                    _subprocess=sp,
                    _repo=repo,
                )

            self.assertEqual(rc, 0)
            # Second call must be gh issue create
            self.assertEqual(sp.run.call_count, 2)
            gh_call_argv = sp.run.call_args_list[1][0][0]
            self.assertEqual(gh_call_argv[0], "gh")
            self.assertIn("--label", gh_call_argv)
            label_idx = gh_call_argv.index("--label")
            self.assertEqual(gh_call_argv[label_idx + 1], TRIAGE_LABEL)

    def test_publish_calls_gh_once_per_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = _make_minimal_repo(tmp_path)
            target = str(tmp_path / "target")

            two_issues = (
                "<!-- ISSUE START -->\nbody one\n<!-- ISSUE END -->\n"
                "<!-- ISSUE START -->\nbody two\n<!-- ISSUE END -->\n"
            )
            agent_proc = SimpleNamespace(returncode=0, stdout=two_issues, stderr="")
            gh_proc = SimpleNamespace(returncode=0)

            sp = MagicMock()
            sp.run.side_effect = [agent_proc, gh_proc, gh_proc]

            with patch.object(issue_mod, "sanitized_env", MagicMock(return_value={})):
                rc = issue_mod._run_headless(
                    agent="claude",
                    command="claude -p --dangerously-skip-permissions",
                    target=target,
                    input_refs=[],
                    dry_run=False,
                    _subprocess=sp,
                    _repo=repo,
                )

            self.assertEqual(rc, 0)
            # 1 agent call + 2 gh calls
            self.assertEqual(sp.run.call_count, 3)


# ---------------------------------------------------------------------------
# main.py routing
# ---------------------------------------------------------------------------

class IssueRoutingTests(unittest.TestCase):
    def test_main_routes_issue_create(self):
        with patch("agentrail.cli.main.run_issue", MagicMock(return_value=0)) as m:
            rc = cli_main(["issue", "create", "docs/milestones/001-foo.md"])
        self.assertEqual(rc, 0)
        m.assert_called_once_with(["create", "docs/milestones/001-foo.md"])

    def test_usage_lists_issue_create(self):
        out = StringIO()
        with patch("sys.stdout", out):
            cli_main([])
        self.assertIn("issue create", out.getvalue())


# ---------------------------------------------------------------------------
# Seed prompt contents (AC4)
# ---------------------------------------------------------------------------

class IssueSeedPromptTests(unittest.TestCase):
    def test_assemble_seed_prompt_contains_skill_and_context(self):
        """assemble_seed_prompt called with to-issues includes skill body + CONTEXT.md."""
        from agentrail.skillcmd.session import assemble_seed_prompt

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            repo = _make_minimal_repo(tmp_path, skill_body="SKILL-CONTENT-HERE")
            target = tmp_path / "target"
            (target / "TASTE.md").write_text("# Taste\n", encoding="utf-8")

            prompt = assemble_seed_prompt(
                repo, target, SKILL_NAME, [], EXTRA_CONTEXT
            )

        self.assertIn("SKILL-CONTENT-HERE", prompt)
        self.assertIn("to-issues", prompt)
        self.assertIn("CONTEXT.md", prompt)
        self.assertIn("TASTE.md", prompt)

    def test_extra_context_includes_required_files(self):
        self.assertIn("TASTE.md", EXTRA_CONTEXT)
        self.assertIn("docs/agents/triage-labels.md", EXTRA_CONTEXT)


if __name__ == "__main__":
    unittest.main()
