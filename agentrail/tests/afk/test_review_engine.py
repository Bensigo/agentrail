"""Unit tests for the native review engine (port of templates/scripts/review-pr)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.afk import review_engine


def _seed_docs(root: Path, *, machine: bool = True) -> None:
    d = root / "agentrail" / "templates" / "docs" / "agents"
    d.mkdir(parents=True)
    (d / "pr-review.md").write_text("PR REVIEW INSTRUCTIONS BODY\n")
    if machine:
        (d / "github-pr-reviewer.md").write_text("MACHINE CONTRACT BODY\n")


class TestBuildReviewPrompt(unittest.TestCase):
    def test_prompt_includes_machine_readable_contract_and_inlined_docs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _seed_docs(root)
            prompt = review_engine.build_review_prompt(
                "12", "Fix the thing", "https://example/pr/12",
                machine_readable=True, repo_root=root,
            )
        # Header
        self.assertIn("Review exactly one pull request: #12.", prompt)
        self.assertIn("Pull request title: Fix the thing", prompt)
        self.assertIn("Pull request URL: https://example/pr/12", prompt)
        # Inlined pr-review doc
        self.assertIn("PR REVIEW INSTRUCTIONS BODY", prompt)
        # Inlined machine-readable contract doc
        self.assertIn("MACHINE CONTRACT BODY", prompt)
        # CRITICAL: the marked JSON block instruction with "even when both
        # arrays are empty"
        self.assertIn("`fix_issues`", prompt)
        self.assertIn("`memory_suggestions`", prompt)
        self.assertIn("even when both", prompt)
        self.assertIn("marked JSON block", prompt)
        # Falls back to agentrail/templates/ path for the contract source label
        self.assertIn(
            "Machine-readable contract source: agentrail/templates/docs/agents/github-pr-reviewer.md",
            prompt,
        )
        # Repo-specific footer
        self.assertIn("Do not edit files.", prompt)

    def test_prompt_omits_contract_when_not_machine_readable(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _seed_docs(root)
            prompt = review_engine.build_review_prompt(
                "5", "T", "U", machine_readable=False, repo_root=root,
            )
        self.assertIn("PR REVIEW INSTRUCTIONS BODY", prompt)
        self.assertNotIn("MACHINE CONTRACT BODY", prompt)
        self.assertNotIn("marked JSON block", prompt)

    def test_prefers_docs_over_templates_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _seed_docs(root)
            installed = root / "docs" / "agents"
            installed.mkdir(parents=True)
            (installed / "pr-review.md").write_text("INSTALLED PR REVIEW\n")
            (installed / "github-pr-reviewer.md").write_text("INSTALLED CONTRACT\n")
            prompt = review_engine.build_review_prompt(
                "1", "T", "U", machine_readable=True, repo_root=root,
            )
        self.assertIn("INSTALLED PR REVIEW", prompt)
        self.assertIn("INSTALLED CONTRACT", prompt)
        self.assertIn(
            "Machine-readable contract source: docs/agents/github-pr-reviewer.md",
            prompt,
        )

    def test_missing_pr_review_doc_raises(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(review_engine.ReviewError):
                review_engine.build_review_prompt(
                    "1", "T", "U", machine_readable=False, repo_root=root,
                )

    def test_missing_machine_contract_raises_when_machine_readable(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _seed_docs(root, machine=False)
            with self.assertRaises(review_engine.ReviewError):
                review_engine.build_review_prompt(
                    "1", "T", "U", machine_readable=True, repo_root=root,
                )

    def test_uses_new_house2_layout_when_only_layout_present(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            new_dir = root / ".agentrail" / "agents"
            new_dir.mkdir(parents=True)
            (new_dir / "pr-review.md").write_text("NEW LAYOUT PR REVIEW\n")
            (new_dir / "github-pr-reviewer.md").write_text("NEW LAYOUT CONTRACT\n")
            prompt = review_engine.build_review_prompt(
                "1", "T", "U", machine_readable=True, repo_root=root,
            )
        self.assertIn("NEW LAYOUT PR REVIEW", prompt)
        self.assertIn("NEW LAYOUT CONTRACT", prompt)
        self.assertIn(
            "Machine-readable contract source: .agentrail/agents/github-pr-reviewer.md",
            prompt,
        )

    def test_prefers_new_house2_layout_over_legacy_and_templates(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _seed_docs(root)
            legacy = root / "docs" / "agents"
            legacy.mkdir(parents=True)
            (legacy / "pr-review.md").write_text("LEGACY PR REVIEW\n")
            (legacy / "github-pr-reviewer.md").write_text("LEGACY CONTRACT\n")
            new_dir = root / ".agentrail" / "agents"
            new_dir.mkdir(parents=True)
            (new_dir / "pr-review.md").write_text("NEW LAYOUT PR REVIEW\n")
            (new_dir / "github-pr-reviewer.md").write_text("NEW LAYOUT CONTRACT\n")
            prompt = review_engine.build_review_prompt(
                "1", "T", "U", machine_readable=True, repo_root=root,
            )
        self.assertIn("NEW LAYOUT PR REVIEW", prompt)
        self.assertIn("NEW LAYOUT CONTRACT", prompt)
        self.assertNotIn("LEGACY PR REVIEW", prompt)
        self.assertNotIn("LEGACY CONTRACT", prompt)


class TestValidateMachineReadableOutput(unittest.TestCase):
    def _write(self, root: Path, text: str) -> Path:
        p = root / "review.md"
        p.write_text(text)
        return p

    def test_accepts_good_block(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p = self._write(root, (
                "some prose\n"
                "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
                '{"fix_issues": [], "memory_suggestions": []}\n'
                "END_REVIEW_FIX_ISSUES_JSON\n"
            ))
            # Should not raise even when both arrays are empty.
            review_engine.validate_machine_readable_output(p)

    def test_rejects_missing_file(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "nope.md"
            with self.assertRaises(review_engine.ReviewError):
                review_engine.validate_machine_readable_output(p)

    def test_rejects_empty_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p = self._write(root, "")
            with self.assertRaises(review_engine.ReviewError):
                review_engine.validate_machine_readable_output(p)

    def test_rejects_missing_block(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p = self._write(root, "just a review, no json block here\n")
            with self.assertRaises(review_engine.ReviewError):
                review_engine.validate_machine_readable_output(p)

    def test_rejects_block_missing_arrays(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            p = self._write(root, (
                "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
                '{"fix_issues": []}\n'
                "END_REVIEW_FIX_ISSUES_JSON\n"
            ))
            with self.assertRaises(review_engine.ReviewError):
                review_engine.validate_machine_readable_output(p)


class TestRunReview(unittest.TestCase):
    def test_codex_invokes_exec_review_subcommand(self):
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return 0

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with patch("agentrail.afk.review_engine.run_with_timeout", fake_run):
                rc = review_engine.run_review(
                    "codex", "main", "12", "PROMPT", str(root / "out.md"),
                    timeout=99, cwd=root,
                )
        self.assertEqual(rc, 0)
        argv = captured["argv"]
        self.assertEqual(argv[:4], ["codex", "exec", "review", "--base"])
        self.assertIn("main", argv)
        self.assertIn("-o", argv)
        self.assertIn(str(root / "out.md"), argv)
        self.assertEqual(captured["kwargs"]["stdin_text"], "PROMPT")
        self.assertEqual(captured["kwargs"]["timeout"], 99)

    def test_codex_passes_review_codex_args(self):
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            return 0

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with patch("agentrail.afk.review_engine.run_with_timeout", fake_run), \
                 patch.dict("os.environ", {"REVIEW_CODEX_ARGS": "--foo bar"}):
                review_engine.run_review(
                    "codex", "main", "12", "P", str(root / "out.md"),
                    timeout=1, cwd=root,
                )
        self.assertIn("--foo", captured["argv"])
        self.assertIn("bar", captured["argv"])

    def test_claude_invokes_claude_via_bash(self):
        captured = {}

        def fake_run(argv, **kwargs):
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return 0

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            out = str(root / "out.md")
            with patch("agentrail.afk.review_engine.run_with_timeout", fake_run):
                rc = review_engine.run_review(
                    "claude", "main", "12", "PROMPT", out, timeout=1, cwd=root,
                )
        self.assertEqual(rc, 0)
        self.assertEqual(captured["argv"][:2], ["bash", "-lc"])
        self.assertIn("claude -p --allowedTools Bash,Read", captured["argv"][2])
        # claude tees its stdout to the output file directly
        self.assertEqual(str(captured["kwargs"]["output_file"]), out)

    def test_unsupported_engine_raises(self):
        with self.assertRaises(review_engine.ReviewError):
            review_engine.run_review("frob", "main", "1", "P", None, timeout=1)


if __name__ == "__main__":
    unittest.main()
