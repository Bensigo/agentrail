"""Tests for incremental / content-based index caching (issue #502).

Coverage:
  AC1 — unchanged repo returns cacheHit=True regardless of index age.
  AC2 — single-file edit re-chunks only that file; golden comparison vs from-scratch.
  DEL — file deletion removes its records and chunks from the rebuilt index.
  EXCL — changes to excluded paths do not invalidate the index.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from agentrail.context.index import build_index, load_index


def make_repo(**extra_context) -> Path:
    """Create a temp git repo with two Python source files.

    By default only ``src/**`` is indexed so the indexed-file count is
    predictable (2 files) regardless of other files in the repo.
    """
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    ctx: dict = {
        "includeGlobs": ["**/*"],
        # Exclude .agentrail/** so config.json doesn't contribute to counts.
        "excludeGlobs": [".git/**", ".agentrail/**"],
        "maxFileSizeBytes": 262144,
        "skipBinary": True,
        "respectGitIgnore": True,
        "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
        "embedding": {"mode": "disabled", "provider": None, "model": None},
        "summary": {"mode": "disabled", "provider": None, "model": None},
    }
    ctx.update(extra_context)
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({"schemaVersion": 1, "context": ctx}, indent=2), encoding="utf-8"
    )
    (root / "src").mkdir(parents=True)
    (root / "src" / "alpha.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    (root / "src" / "beta.py").write_text("def beta():\n    return 2\n", encoding="utf-8")
    return root


def _age_index(index_path: Path, seconds_old: float = 200.0) -> None:
    """Set index.json mtime to ``seconds_old`` seconds in the past."""
    old_time = time.time() - seconds_old
    os.utime(index_path, (old_time, old_time))


def _age_files(root: Path, seconds_old: float = 400.0) -> None:
    """Set all non-.git file mtimes to ``seconds_old`` seconds in the past."""
    for p in root.rglob("*"):
        if p.is_file() and ".git" not in str(p):
            old_time = time.time() - seconds_old
            os.utime(p, (old_time, old_time))


class ContentBasedCacheTests(unittest.TestCase):
    """AC1: unchanged repo returns cacheHit=True at any index age."""

    def test_second_call_returns_cache_hit(self) -> None:
        root = make_repo()
        r1 = build_index(root)
        self.assertIs(r1["cacheHit"], False, "first build must not be a cache hit")

        r2 = build_index(root)
        self.assertIs(r2["cacheHit"], True, "second build must hit cache when nothing changed")
        self.assertEqual(r2["rebuiltSources"], 0)
        self.assertGreater(r2["reusedSources"], 0)

    def test_cache_hit_with_binary_and_gitignored_files(self) -> None:
        """P1 regression (PR #521 review): the freshness fingerprint must use
        the same file set on write and check. Binary and gitignored files are
        skipped from records but ARE in the glob-filtered walk — deriving the
        write-side fingerprint from records made every cache check miss."""
        root = make_repo()
        # Binary file inside the indexed tree (skipBinary drops it from records).
        (root / "src" / "blob.bin").write_bytes(b"\x00\x01\x02\xff" * 64)
        # Gitignored file inside the indexed tree (respectGitIgnore drops it).
        (root / ".gitignore").write_text("src/generated.py\n", encoding="utf-8")
        (root / "src" / "generated.py").write_text("# generated\n", encoding="utf-8")

        r1 = build_index(root)
        self.assertIs(r1["cacheHit"], False)

        r2 = build_index(root)
        self.assertIs(r2["cacheHit"], True,
                      "binary/gitignored files must not poison the fingerprint")
        self.assertEqual(r2["rebuiltSources"], 0)

    def test_cache_hit_after_120s_window(self) -> None:
        """Index age > 120s must NOT trigger a full rebuild if content is unchanged."""
        root = make_repo()
        # Age the source files so they appear older than the eventual index.
        _age_files(root, seconds_old=400)
        build_index(root)

        index_path = root / ".agentrail" / "context" / "index" / "index.json"
        # Simulate the index having been written 200s ago (past the old 120s expiry).
        _age_index(index_path, seconds_old=200)
        # Source files are 400s old, index is 200s old → files older than index → fresh.

        r2 = build_index(root)
        self.assertIs(r2["cacheHit"], True, "cache must hit when content unchanged, even past 120s")
        self.assertEqual(r2["rebuiltSources"], 0)

    def test_modified_file_still_triggers_rebuild(self) -> None:
        """Even within the cache window, a modified file forces a rebuild."""
        root = make_repo()
        build_index(root)
        (root / "src" / "alpha.py").write_text("def alpha_v2():\n    return 99\n", encoding="utf-8")
        r = build_index(root)
        self.assertNotEqual(r["cacheHit"], True)
        # alpha.py was rebuilt
        index = load_index(root)
        texts = [c.get("content", "") for c in index["chunks"] if c.get("path") == "src/alpha.py"]
        self.assertTrue(any("alpha_v2" in t for t in texts))


class IncrementalRebuildTests(unittest.TestCase):
    """AC2: single-file edit re-chunks only that file; output matches from-scratch."""

    def test_only_edited_file_is_rebuilt(self) -> None:
        root = make_repo()
        build_index(root)

        # Edit only alpha.py.
        (root / "src" / "alpha.py").write_text("def alpha_new():\n    return 42\n", encoding="utf-8")
        r = build_index(root)

        self.assertEqual(r["cacheHit"], "incremental")
        self.assertEqual(r["rebuiltSources"], 1, "only alpha.py should be rebuilt")
        self.assertEqual(r["reusedSources"], 1, "beta.py should be reused")

    def test_incremental_matches_fromscratch(self) -> None:
        """Records/chunks from incremental rebuild equal a from-scratch build."""
        import shutil

        root = make_repo()
        build_index(root)

        # Modify alpha.py.
        new_content = "def alpha_new():\n    return 42\n"
        (root / "src" / "alpha.py").write_text(new_content, encoding="utf-8")

        # Incremental build.
        build_index(root)
        incremental_index = load_index(root)

        # From-scratch build: delete the index and rebuild.
        index_dir = root / ".agentrail" / "context" / "index"
        shutil.rmtree(index_dir)

        build_index(root)
        scratch_index = load_index(root)

        # Compare records by path → contentHash.
        inc_hashes = {r["path"]: r["contentHash"] for r in incremental_index["records"]}
        scr_hashes = {r["path"]: r["contentHash"] for r in scratch_index["records"]}
        self.assertEqual(inc_hashes, scr_hashes, "contentHash per path must match between incremental and scratch")

        # Compare chunk textHash per path.
        inc_chunk_hashes = {(c["path"], c["id"]): c["textHash"] for c in incremental_index["chunks"]}
        scr_chunk_hashes = {(c["path"], c["id"]): c["textHash"] for c in scratch_index["chunks"]}
        self.assertEqual(
            inc_chunk_hashes,
            scr_chunk_hashes,
            "chunk textHash per (path, id) must match between incremental and scratch",
        )

    def test_content_hash_reuse_on_touch(self) -> None:
        """File touched (mtime updated) without content change is reused, not rebuilt."""
        root = make_repo()
        build_index(root)

        # Touch alpha.py without changing content.
        alpha = root / "src" / "alpha.py"
        content = alpha.read_text(encoding="utf-8")
        # Small sleep to ensure mtime changes.
        time.sleep(0.05)
        alpha.write_text(content, encoding="utf-8")

        r = build_index(root)
        self.assertNotEqual(r["cacheHit"], True, "mtime changed so not an exact cache hit")
        self.assertEqual(r["rebuiltSources"], 0, "content unchanged — no file should be rebuilt")
        self.assertEqual(r["reusedSources"], 2)


class FileDeletionTests(unittest.TestCase):
    """File deletion removes its records and chunks from the rebuilt index."""

    def test_deleted_file_absent_from_index(self) -> None:
        root = make_repo()
        build_index(root)

        # Delete alpha.py.
        (root / "src" / "alpha.py").unlink()
        r = build_index(root)

        self.assertNotEqual(r["cacheHit"], True)
        index = load_index(root)
        paths_in_records = {rec["path"] for rec in index["records"]}
        self.assertNotIn("src/alpha.py", paths_in_records, "deleted file must not appear in records")

        paths_in_chunks = {c["path"] for c in index["chunks"]}
        self.assertNotIn("src/alpha.py", paths_in_chunks, "deleted file must not appear in chunks")

        self.assertIn("src/beta.py", paths_in_records, "undeleted file must remain in index")


class ExcludedPathTests(unittest.TestCase):
    """Changes to excluded paths must not invalidate the index."""

    def test_excluded_file_change_returns_cache_hit(self) -> None:
        root = make_repo()
        # Add a file that is covered by excludeGlobs (it's in .agentrail/ which is
        # directory-excluded, so add one under a different excluded-glob pattern).
        # We'll exclude *.log files by adding them to excludeGlobs.
        (root / ".agentrail" / "config.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "context": {
                    "includeGlobs": ["**/*"],
                    "excludeGlobs": [".git/**", ".agentrail/context/**", "*.log"],
                    "maxFileSizeBytes": 262144,
                    "skipBinary": True,
                    "respectGitIgnore": True,
                    "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                    "embedding": {"mode": "disabled", "provider": None, "model": None},
                    "summary": {"mode": "disabled", "provider": None, "model": None},
                },
            }, indent=2),
            encoding="utf-8",
        )
        (root / "build.log").write_text("initial log\n", encoding="utf-8")

        # First build.
        build_index(root)

        # Modify the excluded log file.
        time.sleep(0.05)
        (root / "build.log").write_text("updated log content\n", encoding="utf-8")

        # Second build must still be a cache hit because the log is excluded.
        r = build_index(root)
        self.assertIs(r["cacheHit"], True, "excluded-path change must not invalidate the index")
        self.assertEqual(r["rebuiltSources"], 0)


if __name__ == "__main__":
    unittest.main()
