"""Env-overridable retrieval token budget (issue #1225 AC2).

``resolve_retrieval_max_tokens`` mirrors the existing
``resolve_pack_cutoff`` env-toggle pattern (#1096): production is unaffected
(no env set -> the module default), and the offline packer-tightening A/B can
run a smaller-budget "tightened" packer variant in the SAME process/CLI path
production uses, without a second hardcoded constant.
"""
from __future__ import annotations

import os
import unittest
from contextlib import contextmanager
from typing import Iterator, Optional

from agentrail.context.retrieval import RETRIEVAL_MAX_TOKENS, resolve_retrieval_max_tokens

_ENV = "AGENTRAIL_RETRIEVAL_MAX_TOKENS"


@contextmanager
def _budget_env(value: Optional[str]) -> Iterator[None]:
    prior = os.environ.get(_ENV)
    try:
        if value is None:
            os.environ.pop(_ENV, None)
        else:
            os.environ[_ENV] = value
        yield
    finally:
        if prior is None:
            os.environ.pop(_ENV, None)
        else:
            os.environ[_ENV] = prior


class ResolveRetrievalMaxTokensTests(unittest.TestCase):
    def test_default_is_the_module_constant(self) -> None:
        with _budget_env(None):
            self.assertEqual(resolve_retrieval_max_tokens(), RETRIEVAL_MAX_TOKENS)
        self.assertEqual(RETRIEVAL_MAX_TOKENS, 6000)

    def test_env_override_wins(self) -> None:
        with _budget_env("3000"):
            self.assertEqual(resolve_retrieval_max_tokens(), 3000)

    def test_blank_env_falls_back_to_default(self) -> None:
        with _budget_env("   "):
            self.assertEqual(resolve_retrieval_max_tokens(), RETRIEVAL_MAX_TOKENS)

    def test_non_integer_env_falls_back_to_default(self) -> None:
        with _budget_env("not-a-number"):
            self.assertEqual(resolve_retrieval_max_tokens(), RETRIEVAL_MAX_TOKENS)

    def test_non_positive_env_falls_back_to_default(self) -> None:
        with _budget_env("0"):
            self.assertEqual(resolve_retrieval_max_tokens(), RETRIEVAL_MAX_TOKENS)
        with _budget_env("-500"):
            self.assertEqual(resolve_retrieval_max_tokens(), RETRIEVAL_MAX_TOKENS)


if __name__ == "__main__":
    unittest.main()
