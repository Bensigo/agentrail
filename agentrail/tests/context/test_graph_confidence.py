from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.retrieval import _extract_retrieval_seeds, query_context


def _doc(path: str, chunk_id: str) -> dict:
    return {"source": {"path": path, "id": f"src:{path}"}, "chunk": {"id": chunk_id}}


class RetrievalSeedConfidenceTests(unittest.TestCase):
    def test_low_confidence_candidates_do_not_seed_expansion(self) -> None:
        corpus = [
            _doc("strong_a.py", "c1"),
            _doc("strong_b.py", "c2"),
            _doc("weak_c.py", "c3"),
            _doc("weak_d.py", "c4"),
        ]
        pre_bm25 = {"c1": 10.0, "c2": 9.0, "c3": 0.5, "c4": 0.3}
        seeds = _extract_retrieval_seeds(corpus, pre_bm25)
        self.assertIn("strong_a.py", seeds)
        self.assertIn("strong_b.py", seeds)
        self.assertNotIn("weak_c.py", seeds, "low-confidence candidate should not seed graph expansion")
        self.assertNotIn("weak_d.py", seeds)

    def test_single_strong_seed_is_kept(self) -> None:
        corpus = [_doc("only.py", "c1"), _doc("noise.py", "c2")]
        pre_bm25 = {"c1": 8.0, "c2": 0.2}
        seeds = _extract_retrieval_seeds(corpus, pre_bm25)
        self.assertEqual(seeds, ["only.py"])

    def test_zero_scores_yield_no_seeds(self) -> None:
        corpus = [_doc("a.py", "c1")]
        self.assertEqual(_extract_retrieval_seeds(corpus, {"c1": 0.0}), [])


class AuthorityNoiseTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail" / "config.json").write_text(json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [".git/**", ".agentrail/context/**"],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2), encoding="utf-8")
        # CONTEXT.md / TASTE.md are high-authority docs unrelated to the query token.
        (root / "CONTEXT.md").write_text("# Context\n\nProject control plane overview.\n", encoding="utf-8")
        (root / "TASTE.md").write_text("# Taste\n\nDense operational console.\n", encoding="utf-8")
        (root / "src").mkdir(parents=True)
        (root / "src" / "widget.py").write_text("def zzuniquetoken():\n    return 1\n", encoding="utf-8")
        return root

    def test_high_authority_doc_not_injected_for_unrelated_query(self) -> None:
        root = self.make_repo()
        output = query_context(root, "zzuniquetoken", limit=10)
        paths = [r["path"] for r in output["results"]]
        self.assertIn("src/widget.py", paths)
        self.assertNotIn("CONTEXT.md", paths, "high-authority doc injected into unrelated query budget")
        self.assertNotIn("TASTE.md", paths)


if __name__ == "__main__":
    unittest.main()
