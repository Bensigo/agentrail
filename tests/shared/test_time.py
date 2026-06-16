"""Acceptance tests for format_duration (issue #826).

Covers every checkbox AC from the issue body.  This test is intentionally
RED until the Implementer adds ``format_duration`` to ``agentrail.shared.time``.
"""
from __future__ import annotations

import unittest

from agentrail.shared.time import format_duration


class FormatDurationTest(unittest.TestCase):
    def test_zero_seconds(self) -> None:
        self.assertEqual(format_duration(0), "0s")

    def test_seconds_only(self) -> None:
        self.assertEqual(format_duration(5), "5s")

    def test_minutes_and_seconds(self) -> None:
        self.assertEqual(format_duration(90), "1m 30s")

    def test_hours_minutes_seconds(self) -> None:
        self.assertEqual(format_duration(3661), "1h 1m 1s")


if __name__ == "__main__":
    unittest.main()
