"""Acceptance test for parse_csv_row (issue #845).

AC: parse_csv_row("a, b ,c") returns ["a", "b", "c"]
"""
from __future__ import annotations

import unittest

from agentrail.shared.csv import parse_csv_row


class ParseCsvRowTest(unittest.TestCase):
    def test_splits_and_strips_fields(self) -> None:
        """AC #845: fields are split on commas and each field is stripped."""
        self.assertEqual(parse_csv_row("a, b ,c"), ["a", "b", "c"])


if __name__ == "__main__":
    unittest.main()
