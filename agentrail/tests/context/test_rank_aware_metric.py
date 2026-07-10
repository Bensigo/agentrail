"""Rank-aware nDCG metric + rerank meta for the retrieval eval (issue #1088).

The offline retrieval eval was RANK-BLIND.  ``precisionAtBudget`` and
``fileLevelPrecision.*`` are set-membership fractions: they count how many
relevant files landed in the pack, so they DON'T change when only the ORDER of
the same candidate set changes.  With a real Haiku listwise rerank running, the
reranked order flowed into the result list yet mean ``precisionAtBudget`` stayed
byte-identical to baseline (measured 2026-07-07, identical 0.3250) — the eval
could neither show rerank lift nor falsify it.

``_file_level_ndcg`` (AC1) restores a rank-sensitive signal: nDCG@k over the
ranked retrieval collapsed to distinct files applies a log2 rank discount, so a
reorder of the same set moves the number.  ``_rerank_report`` (AC4) surfaces the
rerank stage's ``method`` / ``llmFallback`` / ``orderChanged`` so a live LLM
rerank and a silent fallback stop producing indistinguishable reports.

These tests pin:
  * the nDCG MATH with synthetic inputs (no index, fully deterministic);
  * AC2 permutation-sensitivity — nDCG moves on a reorder of the SAME candidate
    set while ``precisionAtBudget`` / ``fileLevelPrecision`` stay constant;
  * AC4 rerank-meta extraction, null-safe when the flag is OFF;
  * the wiring surfaces both additions per-fixture and in the corpus means,
    alongside (never replacing) the existing set-membership numbers.
"""
from __future__ import annotations

import math
import unittest
from pathlib import Path

from agentrail.context.evaluation import (
    _dcg,
    _file_level_ndcg,
    _file_level_precision,
    _precision_at_budget,
    _rerank_report,
    evaluate_retrieval,
    format_evaluation_report,
)

REPO_ROOT = Path(__file__).parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"


def _chunks(*paths: str) -> list:
    """Build a ranked/packed result list from a sequence of paths (one per chunk)."""
    return [{"path": path} for path in paths]


class DCGMathTests(unittest.TestCase):
    """`_dcg` applies the standard log2 rank discount (order-sensitive)."""

    def test_first_position_is_undiscounted(self) -> None:
        # rank 1 discount is log2(2) == 1, so a single leading gain is undiscounted.
        self.assertEqual(_dcg([1]), 1.0)

    def test_later_positions_are_discounted(self) -> None:
        # Same gain lower down the ranking contributes less: 1 / log2(3) < 1.
        self.assertAlmostEqual(_dcg([0, 1]), 1 / math.log2(3))

    def test_order_changes_dcg(self) -> None:
        # The whole point: the SAME gains in a different order give a different DCG.
        self.assertNotEqual(_dcg([1, 0, 0]), _dcg([0, 0, 1]))

    def test_empty_is_zero(self) -> None:
        self.assertEqual(_dcg([]), 0.0)


class NDCGMathTests(unittest.TestCase):
    """`_file_level_ndcg` normalizes DCG by the ideal ordering of the same labels."""

    def test_perfect_ordering_is_one(self) -> None:
        # Both relevant files lead the ranking → nDCG 1.0.
        ranked = _chunks("a.py", "b.py", "c.py", "d.py")
        metrics = _file_level_ndcg(ranked, ["a.py", "b.py"], [])
        self.assertEqual(metrics["ndcg"], 1.0)
        self.assertEqual(metrics["relevantFileCount"], 2)

    def test_worst_ordering_is_below_one(self) -> None:
        # Same relevant set, but the relevant files are buried last → nDCG < 1.0.
        ranked = _chunks("c.py", "d.py", "a.py", "b.py")
        metrics = _file_level_ndcg(ranked, ["a.py", "b.py"], [])
        self.assertLess(metrics["ndcg"], 1.0)
        self.assertGreater(metrics["ndcg"], 0.0)

    def test_better_ordering_scores_higher_than_worse(self) -> None:
        # Monotonic: promoting the relevant file raises nDCG.
        better = _file_level_ndcg(_chunks("a.py", "x.py", "y.py"), ["a.py"], [])
        worse = _file_level_ndcg(_chunks("x.py", "y.py", "a.py"), ["a.py"], [])
        self.assertGreater(better["ndcg"], worse["ndcg"])

    def test_no_relevant_files_is_vacuously_perfect(self) -> None:
        # Nothing relevant to order → vacuous 1.0 (matches _file_level_precision).
        metrics = _file_level_ndcg(_chunks("a.py", "b.py"), [], [])
        self.assertEqual(metrics["ndcg"], 1.0)
        self.assertEqual(metrics["relevantFileCount"], 0)

    def test_idcg_zero_guard_when_relevant_never_retrieved(self) -> None:
        # Relevant file exists but is absent from the ranking → IDCG 0 → guarded to 0.0,
        # not a ZeroDivisionError.
        metrics = _file_level_ndcg(_chunks("x.py", "y.py", "z.py"), ["a.py"], [])
        self.assertEqual(metrics["ndcg"], 0.0)

    def test_required_sources_used_when_relevant_paths_empty(self) -> None:
        # relevant_paths falls back to required_sources (matches the other metrics).
        metrics = _file_level_ndcg(_chunks("a.py", "b.py"), [], ["a.py"])
        self.assertEqual(metrics["relevantFileCount"], 1)
        self.assertEqual(metrics["ndcg"], 1.0)

    def test_dedupes_chunks_to_files_in_rank_order(self) -> None:
        # Many chunks of one leading relevant file collapse to a single file entry,
        # so a well-ranked but chunk-heavy file still scores 1.0.
        ranked = _chunks("a.py", "a.py", "a.py", "b.py")
        metrics = _file_level_ndcg(ranked, ["a.py"], [])
        self.assertEqual(metrics["ndcg"], 1.0)
        self.assertEqual(metrics["rankedFilesConsidered"], ["a.py", "b.py"])

    def test_value_is_rounded_and_bounded(self) -> None:
        ranked = _chunks("c.py", "a.py", "b.py")
        metrics = _file_level_ndcg(ranked, ["a.py", "b.py"], [])
        self.assertGreaterEqual(metrics["ndcg"], 0.0)
        self.assertLessEqual(metrics["ndcg"], 1.0)
        # rounded to 6 dp like the sibling metrics
        self.assertEqual(metrics["ndcg"], round(metrics["ndcg"], 6))


class PermutationSensitivityTests(unittest.TestCase):
    """AC2 (load-bearing): nDCG moves on a reorder of the SAME candidate set,
    while the set-membership metrics stay CONSTANT — proving the old metrics are
    rank-blind and the new one is rank-aware."""

    # A fixed relevant set of 2 files (R = 2) inside a 5-file candidate list.
    RELEVANT = ["rel_top.py", "rel_mid.py"]
    # Original ranking: one relevant file leads, the second sits mid-list.
    ORIGINAL = _chunks("rel_top.py", "noise_a.py", "rel_mid.py", "noise_b.py", "noise_c.py")
    # Permutation that pushes the SECOND relevant file from rank 3 down to rank 5,
    # WITHOUT disturbing the top-2 prefix {rel_top.py, noise_a.py}. This keeps every
    # set-membership number constant (same pack, same top-R prefix) while changing
    # the rank of a relevant file — the one thing nDCG is built to notice.
    PERMUTED = _chunks("rel_top.py", "noise_a.py", "noise_b.py", "noise_c.py", "rel_mid.py")
    # limit >= list length, so precisionAtBudget considers the WHOLE set (order-invariant).
    LIMIT = 10

    def _ndcg(self, ranked: list) -> float:
        return _file_level_ndcg(ranked, self.RELEVANT, [])["ndcg"]

    def _pab(self, packed: list) -> float:
        return _precision_at_budget(packed, self.RELEVANT, [], self.LIMIT)["precision"]

    def _flp(self, ranked: list) -> dict:
        return _file_level_precision(ranked, ranked, self.RELEVANT, [])

    def test_ndcg_moves_but_set_metrics_are_constant_under_reorder(self) -> None:
        ndcg_before = self._ndcg(self.ORIGINAL)
        ndcg_after = self._ndcg(self.PERMUTED)
        # The rank-aware metric MOVES: rel_mid.py dropped from rank 3 to rank 5.
        self.assertNotEqual(
            ndcg_before,
            ndcg_after,
            f"nDCG did not move on reorder ({ndcg_before} == {ndcg_after}); "
            "the metric is not rank-aware",
        )
        self.assertGreater(ndcg_before, ndcg_after)  # burying a relevant file lowers nDCG

        # Every set-membership metric stays byte-identical on the SAME permutation.
        self.assertEqual(
            self._pab(self.ORIGINAL),
            self._pab(self.PERMUTED),
            "precisionAtBudget moved on a pure reorder — it is not set-membership",
        )
        flp_before, flp_after = self._flp(self.ORIGINAL), self._flp(self.PERMUTED)
        self.assertEqual(
            flp_before["rPrecision"],
            flp_after["rPrecision"],
            "fileLevelPrecision.rPrecision moved on a pure reorder",
        )
        self.assertEqual(
            flp_before["precisionInPack"],
            flp_after["precisionInPack"],
            "fileLevelPrecision.precisionInPack moved on a pure reorder",
        )

    def test_full_reversal_also_moves_ndcg_only(self) -> None:
        # A second, independent permutation (full reversal) confirms the same split:
        # the fully order-invariant metrics (whole-pack precisionInPack and
        # whole-set precisionAtBudget) are unchanged, while nDCG moves.
        reversed_list = list(reversed(self.ORIGINAL))
        self.assertNotEqual(self._ndcg(self.ORIGINAL), self._ndcg(reversed_list))
        self.assertEqual(self._pab(self.ORIGINAL), self._pab(reversed_list))
        self.assertEqual(
            self._flp(self.ORIGINAL)["precisionInPack"],
            self._flp(reversed_list)["precisionInPack"],
        )


class RerankReportTests(unittest.TestCase):
    """AC4: `_rerank_report` lifts the rerank audit fields, null-safe, and makes a
    live LLM rerank distinguishable from a silent fallback."""

    def test_null_safe_when_compiler_absent(self) -> None:
        self.assertEqual(
            _rerank_report({}),
            {"method": None, "llmFallback": None, "orderChanged": None},
        )

    def test_null_safe_when_rerank_block_absent(self) -> None:
        # compiler present but flag OFF → no rerank block → all fields None.
        self.assertEqual(
            _rerank_report({"compiler": {"tokenPack": {}}}),
            {"method": None, "llmFallback": None, "orderChanged": None},
        )

    def test_null_safe_when_compiler_not_a_dict(self) -> None:
        self.assertEqual(
            _rerank_report({"compiler": "nope"}),
            {"method": None, "llmFallback": None, "orderChanged": None},
        )

    def test_surfaces_deterministic_rerank_fields(self) -> None:
        query = {
            "compiler": {
                "rerank": {
                    "method": "deterministic_code_aware_v1",
                    "orderChanged": True,
                    # llmFallback key absent when the LLM stage never ran
                }
            }
        }
        report = _rerank_report(query)
        self.assertEqual(report["method"], "deterministic_code_aware_v1")
        self.assertTrue(report["orderChanged"])
        self.assertIsNone(report["llmFallback"])

    def test_live_llm_rerank_and_silent_fallback_are_distinguishable(self) -> None:
        # A real LLM rerank that applied its order: method carries the +llm_listwise
        # suffix and there is NO fallback reason.
        applied = _rerank_report(
            {
                "compiler": {
                    "rerank": {
                        "method": "deterministic_code_aware_v1+llm_listwise",
                        "orderChanged": True,
                        "llmFallback": None,
                    }
                }
            }
        )
        # A silent fallback: the deterministic order stands and a fallback reason is
        # recorded honestly.
        fell_back = _rerank_report(
            {
                "compiler": {
                    "rerank": {
                        "method": "deterministic_code_aware_v1",
                        "orderChanged": True,
                        "llmFallback": "llm rerank returned malformed order; kept deterministic",
                    }
                }
            }
        )
        # AC4 core: the two runs no longer produce indistinguishable reports.
        self.assertNotEqual(applied, fell_back)
        self.assertIn("llm_listwise", applied["method"])
        self.assertIsNone(applied["llmFallback"])
        self.assertNotIn("llm_listwise", fell_back["method"])
        self.assertIsNotNone(fell_back["llmFallback"])


class ReportWiringTests(unittest.TestCase):
    """The nDCG metric + rerank meta are reported ALONGSIDE the existing metrics."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)

    def test_every_scored_fixture_has_ndcg_and_rerank_blocks(self) -> None:
        scored = [f for f in self.report["fixtures"] if f["status"] != "skipped"]
        self.assertTrue(scored, "expected at least one non-skipped fixture")
        for fixture in scored:
            metrics = fixture["metrics"]
            # additive: the set-membership blocks are still present
            self.assertIn("precisionAtBudget", metrics)
            self.assertIn("fileLevelPrecision", metrics)
            # new: rank-aware metric
            ndcg = metrics["nDCG"]
            self.assertIn("ndcg", ndcg)
            self.assertGreaterEqual(ndcg["ndcg"], 0.0)
            self.assertLessEqual(ndcg["ndcg"], 1.0)
            self.assertIn("k", ndcg)
            # new: rerank audit, null-safe keys always present
            rerank = metrics["rerank"]
            for key in ("method", "llmFallback", "orderChanged"):
                self.assertIn(key, rerank)

    def test_summary_means_report_ndcg_alongside_set_metrics(self) -> None:
        means = self.report["summary"]["means"]
        # existing means untouched
        self.assertIn("chunkPrecisionAtBudget", means)
        self.assertIn("fileRPrecision", means)
        # new rank-aware mean
        self.assertIn("fileNDCG", means)
        self.assertIsNotNone(means["fileNDCG"])
        self.assertGreaterEqual(means["fileNDCG"], 0.0)
        self.assertLessEqual(means["fileNDCG"], 1.0)

    def test_text_report_surfaces_ndcg_and_rerank_meta(self) -> None:
        text = format_evaluation_report(self.report)
        self.assertIn("fileNDCG=", text)
        self.assertIn("rerankMethod=", text)

    def test_grep_baseline_also_has_ndcg(self) -> None:
        grep_fixtures = self.report["grepBaseline"]["fixtures"]
        self.assertTrue(grep_fixtures)
        for fixture in grep_fixtures:
            self.assertIn("nDCG", fixture["metrics"])


if __name__ == "__main__":
    unittest.main()
