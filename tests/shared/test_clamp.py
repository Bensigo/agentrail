"""Acceptance test for clamp(value, low, high) — issue #838.

Tests the public contract only; implementation lives in agentrail.shared.math.
This file must stay RED until the Implementer adds clamp().
"""
from __future__ import annotations

import unittest

from agentrail.shared.math import clamp


class ClampTest(unittest.TestCase):
    def test_value_within_range_is_returned_unchanged(self) -> None:
        self.assertEqual(clamp(5, 0, 10), 5)

    def test_value_below_low_is_clamped_to_low(self) -> None:
        self.assertEqual(clamp(-3, 0, 10), 0)

    def test_value_above_high_is_clamped_to_high(self) -> None:
        self.assertEqual(clamp(15, 0, 10), 10)


if __name__ == "__main__":
    unittest.main()
