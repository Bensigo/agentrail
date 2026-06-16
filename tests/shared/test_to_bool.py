"""Acceptance test for issue #844 — to_bool(s) helper.

AC1: to_bool("true")  returns True
AC2: to_bool("no")    returns False

This test MUST fail until agentrail/shared/coerce.py exists and exports to_bool.
"""
from __future__ import annotations

import unittest

from agentrail.shared.coerce import to_bool


class ToBoolAcceptanceTest(unittest.TestCase):
    def test_true_string_returns_true(self) -> None:
        """AC1: 'true' (case-insensitive) is truthy."""
        self.assertTrue(to_bool("true"))

    def test_no_string_returns_false(self) -> None:
        """AC2: 'no' is falsy."""
        self.assertFalse(to_bool("no"))
