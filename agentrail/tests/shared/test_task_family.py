"""Tests for the canonical task-family vocabulary (issue #1223).

Pure, dependency-free functions — no corpus, no Langfuse client, no network.
This is the module both the eval corpus (agentrail.evals.corpus.loader) and
the live-run tagging (agentrail.observability.tracer, the ``runs`` table)
build on, so its own correctness is verified in complete isolation here.
"""

from __future__ import annotations

import pytest

from agentrail.shared.task_family import (
    TASK_FAMILY_VALUES,
    family_langfuse_tag,
    is_task_family,
)


def test_task_family_values_are_the_documented_fixed_vocabulary() -> None:
    assert TASK_FAMILY_VALUES == ("bug", "feature", "refactor", "test", "infra")


@pytest.mark.parametrize("value", TASK_FAMILY_VALUES)
def test_is_task_family_accepts_each_vocabulary_value(value: str) -> None:
    assert is_task_family(value) is True


@pytest.mark.parametrize("value", ["chore", "Bug", "bugfix", "", "BUG"])
def test_is_task_family_rejects_unrecognized_strings(value: str) -> None:
    assert is_task_family(value) is False


@pytest.mark.parametrize("value", [None, 42, 3.14, {}, [], object()])
def test_is_task_family_rejects_non_string_values(value: object) -> None:
    assert is_task_family(value) is False


@pytest.mark.parametrize("value", TASK_FAMILY_VALUES)
def test_family_langfuse_tag_formats_recognized_values(value: str) -> None:
    assert family_langfuse_tag(value) == f"family:{value}"


def test_family_langfuse_tag_none_for_absent_value() -> None:
    assert family_langfuse_tag(None) is None


def test_family_langfuse_tag_none_for_unrecognized_value() -> None:
    # A typo'd/unrecognized family must never produce a malformed tag.
    assert family_langfuse_tag("bugfix") is None
    assert family_langfuse_tag("") is None
