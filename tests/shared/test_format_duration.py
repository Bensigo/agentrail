"""Acceptance tests for format_duration (issue #826).

Covers all AC cases from the issue. This test is authored BEFORE any
implementation exists (Red-Green Proof, ADR 0008): it must fail until the
Implementer adds ``format_duration`` to ``agentrail.shared``.
"""
from __future__ import annotations

import unittest

from agentrail.shared import format_duration


class FormatDurationTest(unittest.TestCase):
    """AC: format_duration(seconds) returns a short human-readable string."""

    def test_seconds_only(self) -> None:
        self.assertEqual(format_duration(5), "5s")

    def test_minutes_and_seconds(self) -> None:
        self.assertEqual(format_duration(90), "1m 30s")

    def test_hours_minutes_seconds(self) -> None:
        self.assertEqual(format_duration(3661), "1h 1m 1s")

    def test_zero(self) -> None:
        self.assertEqual(format_duration(0), "0s")


if __name__ == "__main__":
    unittest.main()
