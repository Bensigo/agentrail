"""Unit tests for the AFK review policy (agentrail/afk/review.py).

Ported intent from the deleted bash ``scripts/test-review-memory-suggestions``.

That bash test exercised the legacy ``review-pr`` machine-readable contract: it
fed a review with a ``BEGIN_REVIEW_FIX_ISSUES_JSON`` block carrying both a
``fix_issues`` entry and a ``memory_suggestions`` entry, then asserted the
machine-readable parser pulled them out (the legacy script then created GitHub
issues from them).

The native architecture changed *what happens* with the parsed data — memory
suggestions are surfaced in the advisory PR comment rather than spawned as new
issues (see ``agentrail/afk/review.py`` module docstring) — but the parsing
contract is identical: the machine-readable block's ``fix_issues`` and
``memory_suggestions`` arrays must be extracted faithfully, including each
suggestion's title / target_file / body. These tests pin that contract against
the native ``classify`` + ``advisory_comment`` (the byte-faithful prompt /
validation side is covered by tests/afk/test_review_engine.py).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agentrail.afk import review as review_policy


# The same machine-readable payload the bash test fed the legacy review-pr.
_REVIEW_WITH_MEMORY = (
    "Findings omitted for test.\n"
    "\n"
    "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
    "{\n"
    '  "fix_issues": [\n'
    "    {\n"
    '      "title": "Missing verification for AC2",\n'
    '      "severity": "P1",\n'
    '      "file": "README.md",\n'
    '      "body": "AC2 needs concrete verification evidence."\n'
    "    }\n"
    "  ],\n"
    '  "memory_suggestions": [\n'
    "    {\n"
    '      "kind": "failure-pattern",\n'
    '      "title": "Do not claim ACs without evidence",\n'
    '      "target_file": "docs/memory/failure-patterns.md",\n'
    '      "source": "PR #9 review finding: Missing verification for AC2",\n'
    '      "body": "Future PRs must map each acceptance criterion to '
    'implementation and verification evidence."\n'
    "    }\n"
    "  ]\n"
    "}\n"
    "END_REVIEW_FIX_ISSUES_JSON\n"
)


class ClassifyMemorySuggestionsTests(unittest.TestCase):
    def _classify(self, text: str):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "review.md"
            p.write_text(text)
            return review_policy.classify(p)

    def test_parses_fix_issue_as_blocking(self):
        outcome = self._classify(_REVIEW_WITH_MEMORY)
        self.assertIsNotNone(outcome)
        self.assertTrue(outcome.has_blocking)
        finding = outcome.blocking[0]
        self.assertEqual(finding.title, "Missing verification for AC2")
        self.assertEqual(finding.severity, "P1")
        self.assertEqual(finding.file, "README.md")

    def test_parses_memory_suggestions_array(self):
        outcome = self._classify(_REVIEW_WITH_MEMORY)
        self.assertIsNotNone(outcome)
        self.assertEqual(len(outcome.memory_suggestions), 1)
        mem = outcome.memory_suggestions[0]
        # The fields the bash test asserted appeared on the created issue.
        self.assertEqual(mem["kind"], "failure-pattern")
        self.assertEqual(mem["title"], "Do not claim ACs without evidence")
        self.assertEqual(mem["target_file"], "docs/memory/failure-patterns.md")
        self.assertIn("Future PRs must map each acceptance criterion", mem["body"])

    def test_empty_memory_suggestions_is_empty_list(self):
        text = (
            "BEGIN_REVIEW_FIX_ISSUES_JSON\n"
            '{"fix_issues": [], "memory_suggestions": []}\n'
            "END_REVIEW_FIX_ISSUES_JSON\n"
        )
        outcome = self._classify(text)
        self.assertIsNotNone(outcome)
        self.assertEqual(outcome.memory_suggestions, [])
        self.assertTrue(outcome.is_clean)

    def test_unparseable_block_returns_none(self):
        outcome = self._classify("no machine-readable block here\n")
        self.assertIsNone(outcome)


class AdvisoryCommentMemorySuggestionsTests(unittest.TestCase):
    """The native surface for memory suggestions is the advisory PR comment
    (replacing the legacy issue-spawning). It must render the suggestion title
    and its target memory file — the data the bash test asserted on the issue."""

    def test_advisory_comment_renders_memory_suggestion(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "review.md"
            p.write_text(_REVIEW_WITH_MEMORY)
            outcome = review_policy.classify(p)
        # Force the finding into the advisory bucket so the comment renders.
        advisory_outcome = review_policy.ReviewOutcome(
            blocking=[],
            advisory=outcome.blocking + outcome.advisory,
            memory_suggestions=outcome.memory_suggestions,
        )
        comment = review_policy.advisory_comment(9, advisory_outcome)
        self.assertIn("Suggested memory updates", comment)
        self.assertIn("Do not claim ACs without evidence", comment)
        self.assertIn("docs/memory/failure-patterns.md", comment)


if __name__ == "__main__":
    unittest.main()
