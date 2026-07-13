"""Acceptance test for issue #prompt: README.md must contain a one-line comment
explaining what agentrail is.

AC: README.md has an HTML comment (<!-- ... -->) on a single line that
describes what agentrail is.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_README = Path(__file__).parents[2] / "README.md"

# Matches a standalone single-line HTML comment that occupies its own line,
# e.g.:
#   <!-- AgentRail is the control plane that runs coding agents. -->
# The comment must start at the beginning of the line (optional leading
# whitespace), contain at least 20 characters of content, and not be wrapped
# in backticks (i.e. not inline code).
_STANDALONE_COMMENT = re.compile(r"^<!--(?P<body>[^>\n]{20,})-->", re.MULTILINE)


class TestReadmeComment(unittest.TestCase):
    def test_readme_has_one_line_comment_about_agentrail(self) -> None:
        """README.md must contain a standalone single-line HTML comment that
        mentions 'agentrail' and provides a human-readable explanation."""
        text = _README.read_text(encoding="utf-8")
        matches = _STANDALONE_COMMENT.findall(text)
        self.assertTrue(
            matches,
            "README.md has no standalone single-line HTML comment "
            "(<!-- ... --> on its own line with ≥20 chars of content). "
            "Add a one-line comment explaining what agentrail is.",
        )
        has_agentrail = any("agentrail" in body.lower() for body in matches)
        self.assertTrue(
            has_agentrail,
            f"No standalone HTML comment mentioning 'agentrail' found. "
            f"Comment bodies found: {matches}",
        )
