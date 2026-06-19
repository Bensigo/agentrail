"""Tests for agentrail.context.pack_quality.compute_pack_quality.

The function computes ground-truth-free context-pack quality proxies from the
selected/excluded item lists produced by retrieval. It must be total: tolerate
missing keys, non-dict items and None, and never raise.
"""
from __future__ import annotations

import unittest

from agentrail.context.pack_quality import compute_pack_quality


def _item(**kwargs) -> dict:
    return dict(kwargs)


class PrecisionAtBudgetTests(unittest.TestCase):
    def test_near_one_when_all_selected_required(self) -> None:
        selected = [
            _item(sourceType="context_doc", tokenEstimate=60),
            _item(sourceType="taste_doc", tokenEstimate=40),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=100)
        self.assertEqual(out["precision_at_budget"], 1.0)

    def test_lower_when_filler_present(self) -> None:
        selected = [
            _item(sourceType="context_doc", tokenEstimate=30),
            _item(sourceType="indexed_context", tokenEstimate=70),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=100)
        self.assertAlmostEqual(out["precision_at_budget"], 0.3)

    def test_high_value_authority_counts_as_required(self) -> None:
        # Both critical and high authority are high-value (not filler), so a
        # code-only pack with high-authority items reports non-zero precision.
        selected = [
            _item(authority="critical", tokenEstimate=50),
            _item(authority="high", tokenEstimate=50),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=100)
        self.assertAlmostEqual(out["precision_at_budget"], 1.0)

    def test_low_authority_is_filler(self) -> None:
        selected = [
            _item(authority="high", tokenEstimate=40),
            _item(authority="low", tokenEstimate=60),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=100)
        self.assertAlmostEqual(out["precision_at_budget"], 0.4)

    def test_zero_when_budget_zero(self) -> None:
        selected = [_item(sourceType="context_doc", tokenEstimate=60)]
        out = compute_pack_quality(selected, [], selected_context_tokens=0)
        self.assertEqual(out["precision_at_budget"], 0.0)

    def test_clamped_to_one(self) -> None:
        # required tokens exceed reported budget → clamp, never > 1.
        selected = [_item(sourceType="context_doc", tokenEstimate=200)]
        out = compute_pack_quality(selected, [], selected_context_tokens=100)
        self.assertEqual(out["precision_at_budget"], 1.0)


class CitationCoverageTests(unittest.TestCase):
    def test_one_when_all_hashed(self) -> None:
        selected = [
            _item(contentHash="aaa", tokenEstimate=10),
            _item(textHash="bbb", tokenEstimate=10),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=20)
        self.assertEqual(out["citation_coverage"], 1.0)

    def test_fraction_when_some_lack_hash(self) -> None:
        selected = [
            _item(contentHash="aaa", tokenEstimate=10),
            _item(citation="src/x.py", tokenEstimate=10),  # bare path, no hash
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=20)
        self.assertEqual(out["citation_coverage"], 0.5)

    def test_zero_when_no_items(self) -> None:
        out = compute_pack_quality([], [], selected_context_tokens=0)
        self.assertEqual(out["citation_coverage"], 0.0)

    def test_empty_hash_does_not_count(self) -> None:
        selected = [_item(contentHash="", textHash="   ", tokenEstimate=10)]
        out = compute_pack_quality(selected, [], selected_context_tokens=10)
        self.assertEqual(out["citation_coverage"], 0.0)


class StaleCountTests(unittest.TestCase):
    def test_dict_freshness_stale(self) -> None:
        selected = [
            _item(contentHash="a", freshness={"status": "stale"}, tokenEstimate=10),
            _item(contentHash="b", freshness={"status": "current"}, tokenEstimate=10),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=20)
        self.assertEqual(out["stale_count"], 1)

    def test_string_freshness_expired(self) -> None:
        selected = [_item(contentHash="a", freshness="expired", tokenEstimate=10)]
        out = compute_pack_quality(selected, [], selected_context_tokens=10)
        self.assertEqual(out["stale_count"], 1)

    def test_zero_when_clean(self) -> None:
        selected = [
            _item(contentHash="a", freshness={"status": "current"}, tokenEstimate=10),
            _item(contentHash="b", tokenEstimate=10),  # no freshness at all
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=20)
        self.assertEqual(out["stale_count"], 0)


class DeniedCountTests(unittest.TestCase):
    def test_denied_by_visibility(self) -> None:
        excluded = [_item(path="secret.env", visibility="denied")]
        out = compute_pack_quality([], excluded, selected_context_tokens=0)
        self.assertEqual(out["denied_count"], 1)

    def test_denied_by_authority(self) -> None:
        excluded = [_item(path="x", authority="denied")]
        out = compute_pack_quality([], excluded, selected_context_tokens=0)
        self.assertEqual(out["denied_count"], 1)

    def test_zero_when_none_denied(self) -> None:
        excluded = [_item(path="x", reason="stale_source", visibility="public")]
        out = compute_pack_quality([], excluded, selected_context_tokens=0)
        self.assertEqual(out["denied_count"], 0)


class SourceHashListTests(unittest.TestCase):
    def test_ordering_and_content_hash_preferred(self) -> None:
        selected = [
            _item(contentHash="h1", textHash="t1", tokenEstimate=10),
            _item(textHash="t2", tokenEstimate=10),
            _item(contentHash="h3", tokenEstimate=10),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=30)
        self.assertEqual(out["source_hash_list"], ["h1", "t2", "h3"])

    def test_skips_empties(self) -> None:
        selected = [
            _item(contentHash="h1", tokenEstimate=10),
            _item(citation="bare/path.py", tokenEstimate=10),  # no hash → skipped
            _item(contentHash="h3", tokenEstimate=10),
        ]
        out = compute_pack_quality(selected, [], selected_context_tokens=30)
        self.assertEqual(out["source_hash_list"], ["h1", "h3"])


class DefensiveTests(unittest.TestCase):
    def test_empty_inputs(self) -> None:
        out = compute_pack_quality([], [], selected_context_tokens=0)
        self.assertEqual(
            out,
            {
                "precision_at_budget": 0.0,
                "citation_coverage": 0.0,
                "stale_count": 0,
                "denied_count": 0,
                "source_hash_list": [],
            },
        )

    def test_none_inputs(self) -> None:
        out = compute_pack_quality(None, None, selected_context_tokens=None)  # type: ignore[arg-type]
        self.assertEqual(out["precision_at_budget"], 0.0)
        self.assertEqual(out["citation_coverage"], 0.0)
        self.assertEqual(out["source_hash_list"], [])

    def test_non_dict_items_ignored(self) -> None:
        selected = ["not a dict", None, 42, _item(contentHash="h1", tokenEstimate=10)]
        excluded = [None, "x", _item(visibility="denied")]
        out = compute_pack_quality(selected, excluded, selected_context_tokens=10)  # type: ignore[list-item]
        self.assertEqual(out["source_hash_list"], ["h1"])
        self.assertEqual(out["denied_count"], 1)

    def test_missing_fields_never_raise(self) -> None:
        selected = [{}, {"tokenEstimate": None}, {"freshness": None}]
        out = compute_pack_quality(selected, [{}], selected_context_tokens=5)
        self.assertEqual(out["stale_count"], 0)
        self.assertEqual(out["citation_coverage"], 0.0)

    def test_returns_correct_types(self) -> None:
        selected = [_item(contentHash="h1", sourceType="context_doc", tokenEstimate=10)]
        out = compute_pack_quality(selected, [], selected_context_tokens=10)
        self.assertIsInstance(out["precision_at_budget"], float)
        self.assertIsInstance(out["citation_coverage"], float)
        self.assertIsInstance(out["stale_count"], int)
        self.assertIsInstance(out["denied_count"], int)
        self.assertIsInstance(out["source_hash_list"], list)


class WiringContractTests(unittest.TestCase):
    """The five keys merge cleanly into a runMetadata-shaped dict."""

    def test_merges_five_keys_into_run_metadata(self) -> None:
        run_metadata = {"retrievalMode": "exact", "selectedContextTokens": 20}
        selected = [
            _item(sourceType="context_doc", contentHash="h1", tokenEstimate=10),
            _item(sourceType="indexed_context", textHash="t2", tokenEstimate=10),
        ]
        excluded = [_item(visibility="denied")]
        run_metadata.update(
            compute_pack_quality(selected, excluded, run_metadata["selectedContextTokens"])
        )
        for key in (
            "precision_at_budget",
            "citation_coverage",
            "stale_count",
            "denied_count",
            "source_hash_list",
        ):
            self.assertIn(key, run_metadata)
        self.assertAlmostEqual(run_metadata["precision_at_budget"], 0.5)
        self.assertEqual(run_metadata["citation_coverage"], 1.0)
        self.assertEqual(run_metadata["denied_count"], 1)
        self.assertEqual(run_metadata["source_hash_list"], ["h1", "t2"])


if __name__ == "__main__":
    unittest.main()
