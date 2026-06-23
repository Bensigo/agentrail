"""Frozen eval corpus: load and validate pre-registered coding tasks.

The corpus is the eval harness's irreplaceable asset. Each task pins a
repository at a commit, carries a prompt/issue, references a *hidden* test
suite (the answer key) stored separately from the agent-visible working tree,
declares a ground-truth required-context set, and is tagged by difficulty.

A task is *solved* iff its hidden test suite passes. The hidden tests are
stored under each task's ``answer_key/`` directory and are NEVER placed inside
the path handed to the agent, so the answer key cannot leak into the agent's
context (see ``CONTEXT.md`` / the PRD's "hidden held-out tests" decision).

This module is pure and deterministic: it loads ``task.json`` records, validates
them, and rejects malformed ones with a clear, specific error naming the
offending field. It mirrors the fixture-loading/validation shape established by
``agentrail/context/evaluation.py`` (``load_fixtures`` / ``retrieval-fixtures.json``).
"""

from __future__ import annotations

from .loader import (
    DIFFICULTY_TAGS,
    CorpusError,
    CorpusTask,
    corpus_root,
    load_corpus,
    load_task,
)

__all__ = [
    "DIFFICULTY_TAGS",
    "CorpusError",
    "CorpusTask",
    "corpus_root",
    "load_corpus",
    "load_task",
]
