"""Acceptance test for is_blank(text) — issue #839.

Encodes all three acceptance criteria through the public interface.
This test MUST FAIL before the Implementer adds is_blank to agentrail.shared.
"""
from agentrail.shared import is_blank


def test_empty_string_is_blank():
    assert is_blank("") is True


def test_whitespace_only_is_blank():
    assert is_blank("  ") is True


def test_non_blank_string_is_not_blank():
    assert is_blank("x") is False
