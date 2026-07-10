"""File-level precision metric for the retrieval eval (issue #1044).

``precision_at_budget`` is CHUNK-level: it scores the ~10 chunks the compiler
packs, so a single relevant file that only has 4 chunks caps the score at 0.40
even when retrieval is perfect.  The 0.75-0.85 precision figures quoted for
coding agents are FILE-level, so the eval now also reports a file-level view:

  rPrecision      standard IR R-precision over the ranked retrieval — benchmark
                  comparable ranking quality.
  precisionInPack of the files the compiler actually packed, how many are
                  relevant — low here + high rPrecision = ranker fine, pack noisy.
  recall          of the relevant files, how many made it into the pack — the
                  guard rail that must not drop when precision is tuned.

These tests pin the metric MATH with synthetic inputs (no index needed, fully
deterministic) and confirm the wiring surfaces the metric alongside — never
replacing — the chunk-level number in the report and the corpus means.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from agentrail.context.evaluation import (
    _dedupe_paths,
    _file_level_precision,
    _mean_metric,
    evaluate_retrieval,
    format_evaluation_report,
)

REPO_ROOT = Path(__file__).parent.parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"


def _chunks(*paths: str) -> list:
    """Build a ranked/packed result list from a sequence of paths (one per chunk)."""
    return [{"path": path} for path in paths]


class DedupePathsTests(unittest.TestCase):
    """`_dedupe_paths` collapses chunks to files in rank order."""

    def test_preserves_rank_order_and_dedups_files(self) -> None:
        items = _chunks("a.py", "a.py", "b.py", "a.py", "c.py")
        self.assertEqual(_dedupe_paths(items), ["a.py", "b.py", "c.py"])

    def test_skips_blank_and_none_paths(self) -> None:
        items = [{"path": None}, {"path": ""}, {"path": "a.py"}]
        self.assertEqual(_dedupe_paths(items), ["a.py"])

    def test_empty_input_is_empty(self) -> None:
        self.assertEqual(_dedupe_paths([]), [])


class FileLevelPrecisionMathTests(unittest.TestCase):
    """`_file_level_precision` computes the three file-level numbers correctly."""

    def test_r_precision_perfect_single_file(self) -> None:
        # One relevant file whose chunks lead the ranking → R-precision 1.0.
        metrics = _file_level_precision(_chunks("a.py", "a.py", "b.py"), _chunks("a.py"), ["a.py"], [])
        self.assertEqual(metrics["rPrecision"], 1.0)
        self.assertEqual(metrics["relevantFileCount"], 1)

    def test_r_precision_multi_file_perfect(self) -> None:
        # Top-2 ranked files are exactly the 2 relevant files.
        ranked = _chunks("a.py", "b.py", "c.py")
        metrics = _file_level_precision(ranked, ranked, ["a.py", "b.py"], [])
        self.assertEqual(metrics["rPrecision"], 1.0)

    def test_r_precision_multi_file_imperfect(self) -> None:
        # R=2 but the #2 ranked file is noise → only 1 of top-2 relevant → 0.5.
        ranked = _chunks("a.py", "c.py", "b.py")
        metrics = _file_level_precision(ranked, ranked, ["a.py", "b.py"], [])
        self.assertEqual(metrics["rPrecision"], 0.5)

    def test_ranker_good_but_pack_noisy_is_the_diagnostic(self) -> None:
        # The whole point of the metric: the ranker puts the one relevant file at
        # the top (rPrecision 1.0) but the pack over-fills with 4 noise files
        # (precisionInPack 0.2). High rPrecision + low precisionInPack == the
        # bottleneck is PACKING, not ranking. recall must still be perfect.
        ranked = _chunks("a.py", "a.py")
        packed = _chunks("a.py", "b.py", "c.py", "d.py", "e.py")
        metrics = _file_level_precision(ranked, packed, ["a.py"], [])
        self.assertEqual(metrics["rPrecision"], 1.0)
        self.assertEqual(metrics["precisionInPack"], 0.2)
        self.assertEqual(metrics["recall"], 1.0)
        self.assertEqual(metrics["noisyPackFiles"], ["b.py", "c.py", "d.py", "e.py"])

    def test_recall_drops_when_relevant_file_missing_from_pack(self) -> None:
        # Guard rail: b.py is relevant but never packed → recall 0.5.
        ranked = _chunks("a.py", "x.py", "y.py")
        metrics = _file_level_precision(ranked, ranked, ["a.py", "b.py"], [])
        self.assertEqual(metrics["recall"], 0.5)

    def test_required_sources_used_when_relevant_paths_empty(self) -> None:
        # relevant_paths falls back to required_sources (matches _precision_at_budget).
        metrics = _file_level_precision(_chunks("a.py"), _chunks("a.py"), [], ["a.py"])
        self.assertEqual(metrics["relevantFileCount"], 1)
        self.assertEqual(metrics["rPrecision"], 1.0)

    def test_no_relevant_files_is_vacuously_perfect(self) -> None:
        # Degenerate fixture with nothing expected: nothing to miss, nothing packed.
        metrics = _file_level_precision([], [], [], [])
        self.assertEqual(metrics["rPrecision"], 1.0)
        self.assertEqual(metrics["recall"], 1.0)
        self.assertEqual(metrics["precisionInPack"], 1.0)

    def test_values_are_rounded_and_bounded(self) -> None:
        ranked = _chunks("a.py", "b.py", "c.py")
        packed = _chunks("a.py", "b.py", "c.py")
        metrics = _file_level_precision(ranked, packed, ["a.py", "b.py"], [])
        for key in ("rPrecision", "precisionInPack", "recall"):
            self.assertGreaterEqual(metrics[key], 0.0)
            self.assertLessEqual(metrics[key], 1.0)


class MeanMetricTests(unittest.TestCase):
    """`_mean_metric` averages a nested numeric metric, skipping junk."""

    def test_averages_nested_metric_and_skips_missing_and_bools(self) -> None:
        fixtures = [
            {"metrics": {"fileLevelPrecision": {"rPrecision": 1.0}}},
            {"metrics": {"fileLevelPrecision": {"rPrecision": 0.0}}},
            {"metrics": {}},  # missing → skipped, not counted as 0
            {"metrics": {"fileLevelPrecision": {"rPrecision": True}}},  # bool → skipped
        ]
        self.assertEqual(_mean_metric(fixtures, ("fileLevelPrecision", "rPrecision")), 0.5)

    def test_empty_returns_none(self) -> None:
        self.assertIsNone(_mean_metric([], ("fileLevelPrecision", "rPrecision")))

    def test_top_level_metric_path(self) -> None:
        fixtures = [{"metrics": {"recallAt10": 1.0}}, {"metrics": {"recallAt10": 0.5}}]
        self.assertEqual(_mean_metric(fixtures, ("recallAt10",)), 0.75)


class ReportWiringTests(unittest.TestCase):
    """The file-level metric is reported ALONGSIDE (not replacing) chunk-level."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)

    def test_every_scored_fixture_has_file_level_block(self) -> None:
        scored = [f for f in self.report["fixtures"] if f["status"] != "skipped"]
        self.assertTrue(scored, "expected at least one non-skipped fixture")
        for fixture in scored:
            metrics = fixture["metrics"]
            # chunk-level is still present — file-level is additive, not a swap.
            self.assertIn("precisionAtBudget", metrics)
            file_level = metrics["fileLevelPrecision"]
            for key in ("rPrecision", "precisionInPack", "recall"):
                self.assertIn(key, file_level)
                self.assertGreaterEqual(file_level[key], 0.0)
                self.assertLessEqual(file_level[key], 1.0)

    def test_summary_means_report_both_chunk_and_file_level(self) -> None:
        means = self.report["summary"]["means"]
        self.assertIn("chunkPrecisionAtBudget", means)
        self.assertIn("fileRPrecision", means)
        self.assertIn("fileRecall", means)

    def test_text_report_surfaces_file_level_metric(self) -> None:
        text = format_evaluation_report(self.report)
        self.assertIn("means:", text)
        self.assertIn("fileRPrecision=", text)

    def test_grep_baseline_also_has_file_level(self) -> None:
        grep_fixtures = self.report["grepBaseline"]["fixtures"]
        self.assertTrue(grep_fixtures)
        for fixture in grep_fixtures:
            self.assertIn("fileLevelPrecision", fixture["metrics"])


if __name__ == "__main__":
    unittest.main()
