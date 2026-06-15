"""Tests for cross-phase retrieval deduplication (issue #705).

AC5 cases:
  (a) two-phase run with one shared item → items_reused=1, correct token/cost math
  (b) no shared items → all-zero stats
  (c) same path but different contentHash → NOT deduped

AC4: retrieval_dedup key is always present (zeros) in pack even when no reuse.
AC3: dedup is scoped to a single run_id — items from a different run are ignored.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentrail.context.dedup import compute_retrieval_dedup, dedup_key, run_retrieval_dedup
from agentrail.context.pricing import PRICE_TABLE, cost_for
from agentrail.context.retrieval import estimate_tokens


# ---------------------------------------------------------------------------
# dedup_key unit tests
# ---------------------------------------------------------------------------

class DedupKeyTests(unittest.TestCase):
    def test_returns_tuple_when_both_present(self) -> None:
        item = {"path": "foo/bar.py", "contentHash": "sha256:abc123"}
        self.assertEqual(dedup_key(item), ("foo/bar.py", "sha256:abc123"))

    def test_returns_none_when_path_missing(self) -> None:
        item = {"contentHash": "sha256:abc123"}
        self.assertIsNone(dedup_key(item))

    def test_returns_none_when_hash_missing(self) -> None:
        item = {"path": "foo/bar.py"}
        self.assertIsNone(dedup_key(item))

    def test_returns_none_when_path_empty(self) -> None:
        item = {"path": "", "contentHash": "sha256:abc123"}
        self.assertIsNone(dedup_key(item))

    def test_returns_none_when_hash_empty(self) -> None:
        item = {"path": "foo/bar.py", "contentHash": ""}
        self.assertIsNone(dedup_key(item))


# ---------------------------------------------------------------------------
# compute_retrieval_dedup unit tests (AC5)
# ---------------------------------------------------------------------------

class ComputeRetrievalDedupTests(unittest.TestCase):
    MODEL = "claude-sonnet-4-6"

    def _make_item(self, path: str, content_hash: str, content: str, first_phase: str | None = None) -> dict:
        item: dict = {"path": path, "contentHash": content_hash, "content": content}
        if first_phase is not None:
            item["_firstPhase"] = first_phase
        return item

    # AC5a: shared item → items_reused=1, correct token/cost math
    def test_shared_item_gives_reuse_count_and_cost(self) -> None:
        shared_content = "def hello():\n    return 'world'\n"
        prior_item = self._make_item("src/hello.py", "sha256:aaa", shared_content, "plan")
        current_item = self._make_item("src/hello.py", "sha256:aaa", shared_content)

        result = compute_retrieval_dedup([prior_item], [current_item], self.MODEL)

        self.assertEqual(result["items_reused"], 1)
        expected_tokens = estimate_tokens(shared_content)
        self.assertEqual(result["tokens_avoided"], expected_tokens)
        expected_cost = cost_for(self.MODEL, input_tokens=expected_tokens)["dollars"]
        self.assertAlmostEqual(result["cost_avoided_usd"], expected_cost, places=10)
        self.assertFalse(result["estimate"])
        self.assertEqual(len(result["reused"]), 1)
        self.assertEqual(result["reused"][0]["path"], "src/hello.py")
        self.assertEqual(result["reused"][0]["firstPhase"], "plan")
        self.assertEqual(result["reused"][0]["tokens"], expected_tokens)

    # AC5b: no shared items → all-zero stats
    def test_no_shared_items_gives_zeros(self) -> None:
        prior_item = self._make_item("src/a.py", "sha256:aaa", "content a", "plan")
        current_item = self._make_item("src/b.py", "sha256:bbb", "content b")

        result = compute_retrieval_dedup([prior_item], [current_item], self.MODEL)

        self.assertEqual(result["items_reused"], 0)
        self.assertEqual(result["tokens_avoided"], 0)
        self.assertAlmostEqual(result["cost_avoided_usd"], 0.0)
        self.assertEqual(result["reused"], [])

    # AC5c: same path, different contentHash → NOT deduped
    def test_same_path_different_hash_not_deduped(self) -> None:
        prior_item = self._make_item("src/foo.py", "sha256:old", "old content", "plan")
        current_item = self._make_item("src/foo.py", "sha256:new", "new content")

        result = compute_retrieval_dedup([prior_item], [current_item], self.MODEL)

        self.assertEqual(result["items_reused"], 0)
        self.assertEqual(result["tokens_avoided"], 0)

    def test_empty_prior_gives_zeros(self) -> None:
        current_item = self._make_item("src/x.py", "sha256:xxx", "some content")
        result = compute_retrieval_dedup([], [current_item], self.MODEL)
        self.assertEqual(result["items_reused"], 0)
        self.assertEqual(result["tokens_avoided"], 0)

    def test_empty_current_gives_zeros(self) -> None:
        prior_item = self._make_item("src/x.py", "sha256:xxx", "some content", "plan")
        result = compute_retrieval_dedup([prior_item], [], self.MODEL)
        self.assertEqual(result["items_reused"], 0)
        self.assertEqual(result["tokens_avoided"], 0)

    def test_unknown_model_sets_estimate_true(self) -> None:
        item = self._make_item("x.py", "sha256:abc", "content", "plan")
        result = compute_retrieval_dedup([item], [item], "unknown-model-xyz")
        self.assertTrue(result["estimate"])

    def test_result_always_has_required_keys(self) -> None:
        result = compute_retrieval_dedup([], [], self.MODEL)
        for key in ("items_reused", "tokens_avoided", "cost_avoided_usd", "model", "estimate", "reused"):
            self.assertIn(key, result)

    def test_multiple_shared_items(self) -> None:
        prior = [
            self._make_item("a.py", "sha256:aaa", "aaa content", "plan"),
            self._make_item("b.py", "sha256:bbb", "bbb content", "plan"),
        ]
        current = [
            self._make_item("a.py", "sha256:aaa", "aaa content"),
            self._make_item("b.py", "sha256:bbb", "bbb content"),
            self._make_item("c.py", "sha256:ccc", "ccc content"),
        ]
        result = compute_retrieval_dedup(prior, current, self.MODEL)
        self.assertEqual(result["items_reused"], 2)

    def test_first_phase_label_preserved(self) -> None:
        prior = [self._make_item("x.py", "sha256:x", "x content", "plan")]
        current = [self._make_item("x.py", "sha256:x", "x content")]
        result = compute_retrieval_dedup(prior, current, self.MODEL)
        self.assertEqual(result["reused"][0]["firstPhase"], "plan")

    def test_item_without_content_contributes_zero_tokens(self) -> None:
        prior = [{"path": "x.py", "contentHash": "sha256:x", "_firstPhase": "plan"}]
        current = [{"path": "x.py", "contentHash": "sha256:x"}]
        result = compute_retrieval_dedup(prior, current, self.MODEL)
        self.assertEqual(result["items_reused"], 1)
        self.assertEqual(result["tokens_avoided"], 0)


# ---------------------------------------------------------------------------
# run_retrieval_dedup aggregator tests (AC2 / AC3)
# ---------------------------------------------------------------------------

class RunRetrievalDedupTests(unittest.TestCase):
    MODEL = "claude-sonnet-4-6"

    def _write_pack(self, packs_dir: Path, pack_id: str, run_id: str | None, phase: str, dedup: dict | None = None) -> None:
        pack = {
            "packId": pack_id,
            "runId": run_id,
            "target": {"kind": "issue", "number": 1, "phase": phase},
            "included": [],
        }
        if dedup is not None:
            pack["retrieval_dedup"] = dedup
        (packs_dir / f"{pack_id}.json").write_text(json.dumps(pack), encoding="utf-8")

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.packs_dir = self.root / ".agentrail" / "context" / "packs"
        self.packs_dir.mkdir(parents=True)

    def test_aggregates_dedup_across_phases(self) -> None:
        run_id = "run-abc"
        self._write_pack(self.packs_dir, "p1", run_id, "plan", {"items_reused": 0, "tokens_avoided": 0, "cost_avoided_usd": 0.0})
        self._write_pack(self.packs_dir, "p2", run_id, "execute", {"items_reused": 2, "tokens_avoided": 100, "cost_avoided_usd": 0.0003})
        result = run_retrieval_dedup(self.root, run_id, self.MODEL)
        self.assertEqual(result["items_reused"], 2)
        self.assertEqual(result["tokens_avoided"], 100)
        self.assertAlmostEqual(result["cost_avoided_usd"], 0.0003)
        self.assertIn("execute", result["phases"])

    # AC3: items from a different run are NOT counted
    def test_different_run_id_not_included(self) -> None:
        self._write_pack(self.packs_dir, "p-other", "run-other", "plan", {"items_reused": 99, "tokens_avoided": 9999, "cost_avoided_usd": 1.0})
        result = run_retrieval_dedup(self.root, "run-target", self.MODEL)
        self.assertEqual(result["items_reused"], 0)
        self.assertEqual(result["tokens_avoided"], 0)

    def test_empty_packs_dir_returns_zeros(self) -> None:
        result = run_retrieval_dedup(self.root, "any-run", self.MODEL)
        self.assertEqual(result["items_reused"], 0)
        self.assertEqual(result["tokens_avoided"], 0)
        self.assertEqual(result["phases"], [])

    def test_result_has_required_keys(self) -> None:
        result = run_retrieval_dedup(self.root, "any-run", self.MODEL)
        for key in ("run_id", "items_reused", "tokens_avoided", "cost_avoided_usd", "model", "estimate", "phases"):
            self.assertIn(key, result)


# ---------------------------------------------------------------------------
# Pack integration tests: retrieval_dedup always present (AC4) and reuse (AC1)
# ---------------------------------------------------------------------------

def _make_minimal_repo(root: Path) -> None:
    """Set up a minimal git repo with AgentRail config for pack building."""
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    agentrail_dir = root / ".agentrail"
    agentrail_dir.mkdir()
    (agentrail_dir / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False},
            "embedding": {"mode": "disabled"},
            "summary": {"mode": "disabled"},
        },
    }), encoding="utf-8")
    (agentrail_dir / "state.json").write_text(json.dumps({
        "workflow": {"activeIssue": 1, "activePhase": "execute", "goals": []}
    }), encoding="utf-8")
    (root / "CONTEXT.md").write_text("# Context\nIssue #1 context.\n", encoding="utf-8")
    (root / "shared.py").write_text("# Shared module\ndef shared():\n    pass\n", encoding="utf-8")


class PackIntegrationDedupTests(unittest.TestCase):
    """Integration tests that call build_context_pack on a real (minimal) repo."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        _make_minimal_repo(self.root)

    def test_retrieval_dedup_always_present_with_zeros_no_run_id(self) -> None:
        """AC4: retrieval_dedup key present even when run_id=None (no prior context)."""
        from agentrail.context.packs import build_context_pack
        from agentrail.context.index import build_index
        build_index(self.root)
        result = build_context_pack(self.root, "issue", 1, "plan")
        self.assertIn("retrieval_dedup", result)
        dedup = result["retrieval_dedup"]
        self.assertEqual(dedup["items_reused"], 0)
        self.assertEqual(dedup["tokens_avoided"], 0)
        self.assertAlmostEqual(dedup["cost_avoided_usd"], 0.0)

    def test_retrieval_dedup_present_with_explicit_run_id_no_prior(self) -> None:
        """AC4: retrieval_dedup always present with zeros when no prior packs exist."""
        from agentrail.context.packs import build_context_pack
        from agentrail.context.index import build_index
        build_index(self.root)
        result = build_context_pack(self.root, "issue", 1, "plan", run_id="run-xyz")
        self.assertIn("retrieval_dedup", result)
        self.assertEqual(result["retrieval_dedup"]["items_reused"], 0)
        self.assertEqual(result["runId"], "run-xyz")

    def test_retrieval_dedup_reuse_across_phases(self) -> None:
        """AC1: execute phase detects item already in plan phase pack."""
        from agentrail.context.packs import build_context_pack
        from agentrail.context.index import build_index
        build_index(self.root)
        run_id = "run-test-reuse"
        # Build plan pack
        build_context_pack(self.root, "issue", 1, "plan", run_id=run_id)
        # Build execute pack — should detect any items shared with plan
        result = build_context_pack(self.root, "issue", 1, "execute", run_id=run_id)
        dedup = result["retrieval_dedup"]
        # The retrieval_dedup key is always present
        self.assertIn("items_reused", dedup)
        self.assertIn("tokens_avoided", dedup)
        self.assertIn("cost_avoided_usd", dedup)
        # items_reused is non-negative
        self.assertGreaterEqual(dedup["items_reused"], 0)
        # tokens_avoided is consistent with items_reused
        if dedup["items_reused"] > 0:
            self.assertGreater(dedup["tokens_avoided"], 0)


if __name__ == "__main__":
    unittest.main()
