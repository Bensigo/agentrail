from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index, load_index
from agentrail.context.retrieval import query_context


def make_repo() -> Path:
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
    (root / "src").mkdir(parents=True)
    (root / "src" / "widget.py").write_text("def alpha_token():\n    return 1\n", encoding="utf-8")
    return root


class FreshnessGateTests(unittest.TestCase):
    def widget_chunk_text(self, root: Path) -> str:
        index = load_index(root)
        return " ".join(
            str(c.get("content", "")) for c in index["chunks"] if c.get("path") == "src/widget.py"
        )

    def test_modified_file_reindexes_within_cache_window(self) -> None:
        root = make_repo()
        build_index(root)
        self.assertIn("alpha_token", self.widget_chunk_text(root))

        # Modify the file immediately — well inside the time-cache TTL.
        (root / "src" / "widget.py").write_text("def beta_token():\n    return 2\n", encoding="utf-8")
        build_index(root)

        text = self.widget_chunk_text(root)
        self.assertIn("beta_token", text)
        self.assertNotIn("alpha_token", text, "stale chunk survived the index cache after the file changed")

    def test_query_reflects_change_within_cache_window(self) -> None:
        root = make_repo()
        query_context(root, "alpha_token")
        (root / "src" / "widget.py").write_text("def beta_token():\n    return 2\n", encoding="utf-8")
        query_context(root, "alpha_token")
        self.assertNotIn("alpha_token", self.widget_chunk_text(root))

    def test_query_exposes_zero_stale_embedding_leakage(self) -> None:
        root = make_repo()
        output = query_context(root, "alpha_token")
        self.assertEqual(output["retrievalIntegrity"]["staleEmbeddingLeakage"], 0)
        self.assertEqual(output["audit"]["staleEmbeddingLeakage"], 0)

    def test_unchanged_repo_keeps_cached_index(self) -> None:
        root = make_repo()
        build_index(root)
        index_path = root / ".agentrail" / "context" / "index" / "index.json"
        mtime_after_first = index_path.stat().st_mtime
        # No file changes: the second build must reuse the cache (no rewrite).
        build_index(root)
        self.assertEqual(index_path.stat().st_mtime, mtime_after_first)


if __name__ == "__main__":
    unittest.main()
