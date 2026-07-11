"""Unit tests for the skill-backed agent-session primitive.

Covers command derivation (interactive vs headless per agent, with overrides)
and seed-prompt assembly off disk, plus the invocation seam (mocked subprocess).
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import MagicMock

from agentrail.cli.commands.run import UsageError
from agentrail.skillcmd import session as sess


# ---------------------------------------------------------------------------
# Command derivation (AC4)
# ---------------------------------------------------------------------------

class DeriveCommandTests(unittest.TestCase):
    def test_claude_interactive_drops_p(self):
        argv, interactive = sess.derive_command(
            "claude", "claude -p --dangerously-skip-permissions", headless=False
        )
        self.assertTrue(interactive)
        self.assertNotIn("-p", argv)
        self.assertIn("--dangerously-skip-permissions", argv)
        self.assertEqual(argv[0], "claude")

    def test_codex_interactive_drops_exec(self):
        argv, interactive = sess.derive_command(
            "codex", "codex exec --sandbox danger-full-access -", headless=False
        )
        self.assertTrue(interactive)
        self.assertEqual(argv[0], "codex")
        self.assertNotIn("exec", argv)
        self.assertNotIn("-", argv)  # stdin sentinel dropped

    def test_headless_keeps_headless_command(self):
        argv, interactive = sess.derive_command(
            "claude", "claude -p --dangerously-skip-permissions", headless=True
        )
        self.assertFalse(interactive)
        self.assertIn("-p", argv)

    def test_custom_no_interactive_falls_back_to_headless(self):
        argv, interactive = sess.derive_command(
            "custom", "my-agent run -", headless=False
        )
        self.assertFalse(interactive)
        self.assertEqual(argv, ["my-agent", "run", "-"])

    def test_override_headless_command_transformed_not_replaced(self):
        # A user override must be transformed (preserve their binary/flags),
        # not swapped for the stock interactive builtin.
        argv, interactive = sess.derive_command(
            "claude", "my-claude-wrapper -p --foo", headless=False
        )
        self.assertTrue(interactive)
        self.assertEqual(argv[0], "my-claude-wrapper")
        self.assertNotIn("-p", argv)
        self.assertIn("--foo", argv)

    def test_codex_override_exec_rewritten(self):
        argv, interactive = sess.derive_command(
            "codex", "codex exec --my-flag -", headless=False
        )
        self.assertTrue(interactive)
        self.assertEqual(argv, ["codex", "--my-flag"])


# ---------------------------------------------------------------------------
# Skill loading + seed assembly (AC3)
# ---------------------------------------------------------------------------

class AssembleSeedTests(unittest.TestCase):
    def _make_repo(self, tmp: Path, body="SKILLBODY-VERBATIM"):
        skdir = tmp / "agentrail" / "skills" / "tdd"
        skdir.mkdir(parents=True)
        (skdir / "SKILL.md").write_text(body, encoding="utf-8")
        return tmp

    def test_load_skill_body_verbatim(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d), body="line1\nline2\n")
            self.assertEqual(sess.load_skill_body(repo, "tdd"), "line1\nline2\n")

    def test_missing_skill_raises(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(UsageError) as ctx:
                sess.load_skill_body(Path(d), "tdd")
            # The error names both shipped locations it searched (factory + Jace).
            msg = str(ctx.exception)
            self.assertIn("skills/tdd/SKILL.md", msg)
            self.assertIn("apps/jace/agent/skills/tdd/SKILL.md", msg)

    def test_load_skill_body_falls_back_to_jace(self):
        # Coordinator-flavored skills (grill-me, to-prd, to-milestones,
        # to-issues) ship under apps/jace/agent/skills/, not the factory
        # skills/ dir; the resolver falls back to that second location.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            jdir = repo / "apps" / "jace" / "agent" / "skills" / "to-issues"
            jdir.mkdir(parents=True)
            (jdir / "SKILL.md").write_text("JACE-SKILL-BODY", encoding="utf-8")
            self.assertEqual(
                sess.load_skill_body(repo, "to-issues"), "JACE-SKILL-BODY"
            )

    def test_factory_wins_over_jace_when_both_exist(self):
        # If a name resolves in both locations, the factory copy is preferred
        # (first candidate), so no coordinator skill can shadow a factory one.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            fdir = repo / "agentrail" / "skills" / "dup"
            fdir.mkdir(parents=True)
            (fdir / "SKILL.md").write_text("FACTORY", encoding="utf-8")
            jdir = repo / "apps" / "jace" / "agent" / "skills" / "dup"
            jdir.mkdir(parents=True)
            (jdir / "SKILL.md").write_text("JACE", encoding="utf-8")
            self.assertEqual(sess.load_skill_body(repo, "dup"), "FACTORY")

    def test_assemble_includes_skill_and_context(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            target.mkdir()
            (target / "CONTEXT.md").write_text("DOMAIN-GLOSSARY", encoding="utf-8")
            (target / "TASTE.md").write_text("TASTE-RULES", encoding="utf-8")
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", [], ["TASTE.md"]
            )
            self.assertIn("SKILLBODY-VERBATIM", out)
            self.assertIn("DOMAIN-GLOSSARY", out)
            self.assertIn("TASTE-RULES", out)

    def test_assemble_inlines_file_input_ref(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            target.mkdir()
            (target / "plan.md").write_text("MY-PLAN-CONTENT", encoding="utf-8")
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", ["plan.md"], []
            )
            self.assertIn("MY-PLAN-CONTENT", out)
            self.assertIn("## Input: plan.md", out)

    def test_assemble_treats_unknown_ref_as_inline_text(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            target.mkdir()
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", ["just an idea"], []
            )
            self.assertIn("just an idea", out)

    def test_assemble_uses_new_house2_layout_when_only_layout_present(self):
        # Repo-structure v2: CONTEXT.md/TASTE.md live under .agentrail/ as
        # context.md/taste.md. With no legacy files present at all, the new
        # layout alone must satisfy both.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            new_dir = target / ".agentrail"
            new_dir.mkdir(parents=True)
            (new_dir / "context.md").write_text("NEW-DOMAIN-GLOSSARY", encoding="utf-8")
            (new_dir / "taste.md").write_text("NEW-TASTE-RULES", encoding="utf-8")
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", [], ["TASTE.md"]
            )
            self.assertIn("SKILLBODY-VERBATIM", out)
            self.assertIn("NEW-DOMAIN-GLOSSARY", out)
            self.assertIn("NEW-TASTE-RULES", out)

    def test_assemble_prefers_new_house2_layout_over_legacy(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            target.mkdir()
            (target / "CONTEXT.md").write_text("LEGACY-DOMAIN-GLOSSARY", encoding="utf-8")
            (target / "TASTE.md").write_text("LEGACY-TASTE-RULES", encoding="utf-8")
            new_dir = target / ".agentrail"
            new_dir.mkdir(parents=True)
            (new_dir / "context.md").write_text("NEW-DOMAIN-GLOSSARY", encoding="utf-8")
            (new_dir / "taste.md").write_text("NEW-TASTE-RULES", encoding="utf-8")
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", [], ["TASTE.md"]
            )
            self.assertIn("NEW-DOMAIN-GLOSSARY", out)
            self.assertIn("NEW-TASTE-RULES", out)
            self.assertNotIn("LEGACY-DOMAIN-GLOSSARY", out)
            self.assertNotIn("LEGACY-TASTE-RULES", out)

    def test_assemble_falls_back_to_legacy_layout(self):
        # No .agentrail/ present at all: unchanged pre-v2 behavior.
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            target.mkdir()
            (target / "CONTEXT.md").write_text("LEGACY-DOMAIN-GLOSSARY", encoding="utf-8")
            (target / "TASTE.md").write_text("LEGACY-TASTE-RULES", encoding="utf-8")
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", [], ["TASTE.md"]
            )
            self.assertIn("LEGACY-DOMAIN-GLOSSARY", out)
            self.assertIn("LEGACY-TASTE-RULES", out)

    def test_assemble_maps_docs_agents_extra_context_to_new_layout(self):
        # issue.py's EXTRA_CONTEXT includes "docs/agents/triage-labels.md",
        # which must resolve to .agentrail/agents/triage-labels.md in the new
        # layout (docs/ prefix stripped).
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = self._make_repo(Path(d))
            target = Path(d) / "proj"
            new_dir = target / ".agentrail" / "agents"
            new_dir.mkdir(parents=True)
            (new_dir / "triage-labels.md").write_text("NEW-TRIAGE-LABELS", encoding="utf-8")
            out = sess.assemble_seed_prompt(
                repo, target, "tdd", [], ["docs/agents/triage-labels.md"]
            )
            self.assertIn("NEW-TRIAGE-LABELS", out)


# ---------------------------------------------------------------------------
# Invocation (AC1/AC2) — mocked subprocess
# ---------------------------------------------------------------------------

class RunSkillSessionTests(unittest.TestCase):
    def _repo_and_target(self, d):
        repo = Path(d)
        skdir = repo / "agentrail" / "skills" / "tdd"
        skdir.mkdir(parents=True)
        (skdir / "SKILL.md").write_text("SKILLBODY", encoding="utf-8")
        target = repo / "proj"
        target.mkdir()
        (target / "CONTEXT.md").write_text("CTX", encoding="utf-8")
        return repo, target

    def test_interactive_passes_seed_as_positional(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo, target = self._repo_and_target(d)
            fake_sub = MagicMock()
            fake_sub.run.return_value = MagicMock(returncode=0)
            rc = sess.run_skill_session(
                "tdd", str(target), [],
                agent="claude", command="claude -p --dangerously-skip-permissions",
                headless=False, repo_dir=repo, _subprocess=fake_sub,
            )
            self.assertEqual(rc, 0)
            called_argv, kwargs = fake_sub.run.call_args[0], fake_sub.run.call_args[1]
            argv = called_argv[0]
            self.assertEqual(argv[0], "claude")
            self.assertNotIn("-p", argv)
            # Seed is the trailing positional and contains skill + context.
            self.assertIn("SKILLBODY", argv[-1])
            self.assertIn("CTX", argv[-1])
            # No stdin feed in interactive mode.
            self.assertNotIn("input", kwargs)

    def test_headless_feeds_seed_on_stdin(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo, target = self._repo_and_target(d)
            fake_sub = MagicMock()
            fake_sub.run.return_value = MagicMock(returncode=7)
            rc = sess.run_skill_session(
                "tdd", str(target), [],
                agent="claude", command="claude -p --dangerously-skip-permissions",
                headless=True, repo_dir=repo, _subprocess=fake_sub,
            )
            self.assertEqual(rc, 7)  # exits with agent's code (AC2)
            kwargs = fake_sub.run.call_args[1]
            self.assertIn("SKILLBODY", kwargs["input"])
            self.assertIn("CTX", kwargs["input"])
            argv = fake_sub.run.call_args[0][0]
            self.assertIn("-p", argv)  # headless command retained

    def test_no_interactive_form_warns_and_falls_back(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo, target = self._repo_and_target(d)
            fake_sub = MagicMock()
            fake_sub.run.return_value = MagicMock(returncode=0)
            from io import StringIO
            from unittest.mock import patch
            err = StringIO()
            with patch("sys.stderr", err):
                sess.run_skill_session(
                    "tdd", str(target), [],
                    agent="custom", command="my-agent -",
                    headless=False, repo_dir=repo, _subprocess=fake_sub,
                )
            self.assertIn("warning", err.getvalue().lower())
            # Fell back to headless: seed on stdin.
            self.assertIn("SKILLBODY", fake_sub.run.call_args[1]["input"])

    def test_child_env_strips_session_markers(self):
        # The child agent must not inherit the parent's agent-session markers
        # (CLAUDECODE/CODEX_SESSION/…), or it may refuse to start a fresh
        # session — same sanitization `run` applies.
        import os
        import tempfile
        from unittest.mock import patch
        for headless in (False, True):
            with tempfile.TemporaryDirectory() as d:
                repo, target = self._repo_and_target(d)
                fake_sub = MagicMock()
                fake_sub.run.return_value = MagicMock(returncode=0)
                with patch.dict(os.environ, {"CLAUDECODE": "1", "CODEX_SESSION": "x"}):
                    sess.run_skill_session(
                        "tdd", str(target), [],
                        agent="claude",
                        command="claude -p --dangerously-skip-permissions",
                        headless=headless, repo_dir=repo, _subprocess=fake_sub,
                    )
                env = fake_sub.run.call_args[1]["env"]
                self.assertNotIn("CLAUDECODE", env)
                self.assertNotIn("CODEX_SESSION", env)


if __name__ == "__main__":
    unittest.main()
