"""Acceptance tests for agentrail.shared.text.truncate (issue #832).

These tests encode the AC contract. They MUST FAIL before the feature is
implemented (the module does not exist yet) and pass once the Implementer adds
agentrail/shared/text.py with a truncate() function.
"""
from __future__ import annotations

import unittest

from agentrail.shared.text import truncate


class TruncateTest(unittest.TestCase):
    def test_short_text_returned_unchanged(self) -> None:
        """AC: truncate("hello", 10) returns "hello" (len < limit)."""
        self.assertEqual(truncate("hello", 10), "hello")

    def test_text_at_limit_returned_unchanged(self) -> None:
        """AC: truncate("hello", 5) returns "hello" (len == limit)."""
        self.assertEqual(truncate("hello", 5), "hello")

    def test_long_text_cut_and_ellipsis_appended(self) -> None:
        """AC: truncate("hello world", 5) returns "hello…" (len > limit)."""
        self.assertEqual(truncate("hello world", 5), "hello\u2026")

    def test_empty_string_returned_unchanged(self) -> None:
        """AC: truncate("", 5) returns ""."""
        self.assertEqual(truncate("", 5), "")


if __name__ == "__main__":
    unittest.main()
