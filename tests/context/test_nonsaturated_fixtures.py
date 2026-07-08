"""AC3 (#1088): the retrieval fixture corpus must NOT be recall-saturated.

If every fixture retrieves all its relevant files inside the top 5 (recall@5 == 1.0
everywhere), then recall has no headroom: no retrieval regression and no over-aggressive
pack trim can ever move the number, so the offline eval cannot certify a precision change
without hiding a recall loss. These tests pin the invariant that at least two fixtures are
genuinely non-saturated (a real cross-file dependency ranks outside the top 5) while their
required sources stay retrievable.

Recall@5 here is computed exactly as ``_evaluate_fixture`` computes it: run the real
retriever via ``query_context`` and measure how many ``_expected_included`` files land in
the first five ranked result paths.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from typing import Dict, List

from agentrail.context import evaluation as ev

REPO_ROOT = Path(__file__).parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"

# The two fixtures added for AC3, and the genuine dependency each one deliberately
# leaves outside the top 5 (verified genuine by import: index.py:13 imports
# source_record_for_file from sources.py; packs.py:16 imports compute_pack_quality
# from pack_quality.py).
HARD_FIXTURES = {
    "context-index-build-hard": "agentrail/context/sources.py",
    "context-pack-build-hard": "agentrail/context/pack_quality.py",
}


def _query(fixture: Dict) -> Dict:
    limit = int(fixture.get("limit") or 10)
    return ev.query_context(REPO_ROOT, fixture["task"], limit=limit)


def _recall_at_5(fixture: Dict) -> float:
    query = _query(fixture)
    result_paths = ev._paths(query.get("results", []))
    top5 = set(result_paths[:5])
    expected = ev._expected_included(fixture)
    return ev._recall(expected, top5)


def _missing_required(fixture: Dict) -> List[str]:
    query = _query(fixture)
    results = query.get("results", [])
    included = set(ev._included_paths(query, results))
    required = ev._unique(list(fixture.get("requiredSources", [])) or ev._expected_included(fixture))
    return [path for path in required if path not in included]


class NonSaturatedCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixtures = ev.load_fixtures(RETRIEVAL_FIXTURE_FILE)
        cls.by_name = {fx["name"]: fx for fx in cls.fixtures}

    def test_at_least_two_fixtures_are_non_saturated(self) -> None:
        """AC3: >= 2 fixtures have baseline recall@5 < 1.0 so recall can register a change."""
        non_saturated = [fx["name"] for fx in self.fixtures if _recall_at_5(fx) < 1.0]
        self.assertGreaterEqual(
            len(non_saturated),
            2,
            f"recall corpus is saturated; non-saturated fixtures = {non_saturated}",
        )

    def test_named_hard_fixtures_are_non_saturated(self) -> None:
        """The dedicated -hard fixtures each leave a genuine dependency outside the top 5."""
        for name, deep_dep in HARD_FIXTURES.items():
            with self.subTest(fixture=name):
                fixture = self.by_name.get(name)
                self.assertIsNotNone(fixture, f"missing fixture {name}")
                self.assertLess(
                    _recall_at_5(fixture),
                    1.0,
                    f"{name} is saturated (recall@5 == 1.0); the recall trap is gone",
                )
                self.assertIn(
                    deep_dep,
                    ev._expected_included(fixture),
                    f"{name} must expect its genuine deep dependency {deep_dep}",
                )

    def test_hard_fixtures_keep_required_sources_retrievable(self) -> None:
        """Non-saturation must come from a deep EXPECTED file, never a missing REQUIRED one."""
        for name in HARD_FIXTURES:
            with self.subTest(fixture=name):
                fixture = self.by_name[name]
                self.assertEqual(
                    _missing_required(fixture),
                    [],
                    f"{name} dropped a required source; that would be a hard failure, not a recall trap",
                )

    def test_deep_dependency_is_not_in_required_sources(self) -> None:
        """The deep dependency stays out of requiredSources (else it hard-fails instead of lowering recall)."""
        for name, deep_dep in HARD_FIXTURES.items():
            with self.subTest(fixture=name):
                fixture = self.by_name[name]
                self.assertNotIn(deep_dep, fixture.get("requiredSources", []))


if __name__ == "__main__":
    unittest.main()
