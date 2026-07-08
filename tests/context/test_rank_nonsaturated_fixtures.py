"""#1107: the retrieval fixture corpus must NOT be RANK-saturated.

This is the RANK analog of ``test_nonsaturated_fixtures.py`` (#1088 AC3, which
pinned non-saturated RECALL fixtures).  ``_file_level_ndcg`` is the only
rank-aware retrieval metric (#1088 AC1 / #1105): it moves when the ORDER of the
same retrieved set changes, where the set-membership fractions
(``precisionAtBudget``, ``fileLevelPrecision``) do not.  With the Haiku listwise
rerank now firing (#1106) it is the number a rerank can actually lift.

But 6 of the 7 fixtures already sit at per-fixture ``fileNDCG == 1.0`` with the
flag OFF -- the deterministic ``deterministic_code_aware_v1`` rerank already puts
every relevant file first, so the LLM rerank has no headroom to demonstrate lift
and the OFF-vs-ON delta is ~0.  These tests pin the invariant that at least two
fixtures are genuinely rank-non-saturated: a GENUINELY-relevant file (a real
import dependency) is RETRIEVED but the deterministic order ranks it BELOW a file
outside the relevant set, so baseline ``fileNDCG < 1.0`` and a good reorder can
move the number -- while their required sources stay retrievable (a rank miss,
never a hard failure).

``fileNDCG`` here is computed exactly as ``_evaluate_fixture`` computes it: run
the real retriever via ``query_context`` and score ``_file_level_ndcg`` over the
ranked results with relevance = ``expectedFiles ∪ requiredSources``.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from typing import Dict, List

from agentrail.context import evaluation as ev

REPO_ROOT = Path(__file__).parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"

# The two fixtures added for #1107, and the genuine dependency each one
# deliberately leaves ranked below a non-relevant file (verified genuine by
# import: retrieval.py:19 imports rerank_candidates/rerank_enabled from
# rerank.py; packs.py:15 imports build_memory_lane/frame_untrusted_memory from
# memory_lane.py).
RANK_HARD_FIXTURES = {
    "query-context-rerank-rank-hard": "agentrail/context/rerank.py",
    "context-pack-build-rank-hard": "agentrail/context/memory_lane.py",
}


def _query(fixture: Dict) -> Dict:
    limit = int(fixture.get("limit") or 10)
    return ev.query_context(REPO_ROOT, fixture["task"], limit=limit)


def _relevant(fixture: Dict) -> List[str]:
    """Relevant set exactly as ``_evaluate_fixture`` builds it for nDCG."""
    required = ev._unique(list(fixture.get("requiredSources", [])) or ev._expected_included(fixture))
    return ev._unique(ev._expected_included(fixture) + required)


def _file_ndcg(fixture: Dict) -> float:
    query = _query(fixture)
    results = query.get("results", [])
    required = list(fixture.get("requiredSources", []))
    return ev._file_level_ndcg(results, _relevant(fixture), required)["ndcg"]


def _missing_required(fixture: Dict) -> List[str]:
    query = _query(fixture)
    results = query.get("results", [])
    included = set(ev._included_paths(query, results))
    required = ev._unique(list(fixture.get("requiredSources", [])) or ev._expected_included(fixture))
    return [path for path in required if path not in included]


class RankNonSaturatedCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixtures = ev.load_fixtures(RETRIEVAL_FIXTURE_FILE)
        cls.by_name = {fx["name"]: fx for fx in cls.fixtures}

    def test_at_least_two_fixtures_are_rank_non_saturated(self) -> None:
        """#1107 AC1: >= 2 fixtures have baseline fileNDCG < 1.0 so a rerank can register lift."""
        non_saturated = [fx["name"] for fx in self.fixtures if _file_ndcg(fx) < 1.0]
        self.assertGreaterEqual(
            len(non_saturated),
            2,
            f"rank corpus is saturated (every fileNDCG == 1.0); a reranker has no "
            f"headroom to demonstrate lift. non-saturated fixtures = {non_saturated}",
        )

    def test_named_rank_hard_fixtures_are_non_saturated(self) -> None:
        """Each dedicated -rank-hard fixture leaves a genuine dependency ranked below noise."""
        for name, buried_dep in RANK_HARD_FIXTURES.items():
            with self.subTest(fixture=name):
                fixture = self.by_name.get(name)
                self.assertIsNotNone(fixture, f"missing fixture {name}")
                ndcg = _file_ndcg(fixture)
                self.assertLess(
                    ndcg,
                    1.0,
                    f"{name} is rank-saturated (fileNDCG == {ndcg}); the rank trap is gone",
                )
                self.assertIn(
                    buried_dep,
                    ev._expected_included(fixture),
                    f"{name} must expect its genuine buried dependency {buried_dep}",
                )

    def test_rank_hard_fixtures_keep_required_sources_retrievable(self) -> None:
        """Non-saturation must come from a MISPLACED expected file, never a missing REQUIRED one."""
        for name in RANK_HARD_FIXTURES:
            with self.subTest(fixture=name):
                fixture = self.by_name[name]
                self.assertEqual(
                    _missing_required(fixture),
                    [],
                    f"{name} dropped a required source; that is a hard failure, not a rank trap",
                )

    def test_buried_dependency_is_not_in_required_sources(self) -> None:
        """The buried dependency stays out of requiredSources (else it hard-fails instead of lowering nDCG)."""
        for name, buried_dep in RANK_HARD_FIXTURES.items():
            with self.subTest(fixture=name):
                fixture = self.by_name[name]
                self.assertNotIn(buried_dep, fixture.get("requiredSources", []))

    def test_buried_dependency_is_retrieved_but_ranked_below_a_non_relevant_file(self) -> None:
        """The trap is a RANK miss: the buried dep IS retrieved, but a non-relevant file
        outranks it in the deterministic distinct-file order (which is exactly what makes
        fileNDCG < 1.0 and gives a task-aware reranker something to fix)."""
        for name, buried_dep in RANK_HARD_FIXTURES.items():
            with self.subTest(fixture=name):
                fixture = self.by_name[name]
                query = _query(fixture)
                ranked_files = ev._dedupe_paths(query.get("results", []))
                self.assertIn(
                    buried_dep,
                    ranked_files,
                    f"{name}: buried dep {buried_dep} was not retrieved at all (that is a recall "
                    "miss, not the rank miss this fixture pins)",
                )
                relevant = set(_relevant(fixture))
                buried_rank = ranked_files.index(buried_dep)
                above = ranked_files[:buried_rank]
                self.assertTrue(
                    any(path not in relevant for path in above),
                    f"{name}: nothing non-relevant ranks above {buried_dep}, so fileNDCG cannot be < 1.0",
                )


if __name__ == "__main__":
    unittest.main()
