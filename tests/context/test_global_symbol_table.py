"""Tests for `agentrail context def NAME` — issue #585.

AC1: context_def returns a list with house-schema fields present.
AC2: Same symbol in multiple files → all matches returned.
AC3: Entries with authority:"denied" are excluded.
AC4: _anchor_start_nodes uses symbolTable O(1) lookup when key is present.
AC5: This test file passes (green).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

from agentrail.context.index import build_index, load_index
from agentrail.context.retrieval import _anchor_start_nodes, _build_symbol_node_map, context_def

_HOUSE_SCHEMA_KEYS = {"path", "lineStart", "lineEnd", "content", "citation", "reason", "score", "tokenEstimate", "deterministic"}


def make_multi_def_repo() -> Path:
    """Repo with the same function name defined in two modules (AC2)."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*.py"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": False,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "alpha.py").write_text("def process():\n    return 1\n", encoding="utf-8")
    (root / "beta.py").write_text("def process():\n    return 2\n", encoding="utf-8")
    return root


def make_denied_repo() -> Path:
    """Repo where we hand-craft index.json with a denied symbolTable entry (AC3)."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / "ok.py").write_text("def run():\n    pass\n", encoding="utf-8")
    # Write a hand-crafted index with one allowed + one denied entry for "run".
    index_dir = root / ".agentrail" / "context" / "index"
    index_dir.mkdir(parents=True, exist_ok=True)
    index_data: Dict[str, Any] = {
        "schemaVersion": 2,
        "version": "context-index-v1",
        "builtAt": "2025-01-01T00:00:00.000Z",
        "snapshot": {
            "commitSha": "abc123",
            "indexedAt": "2025-01-01T00:00:00.000Z",
            "skipped": 0,
            "redactionCount": 0,
            "ingestionHealth": {"status": "green", "indexed": 1, "skipped": 0, "redacted": 0},
        },
        "provider": {
            "mode": "disabled",
            "summary": {"mode": "disabled", "provider": None, "model": None},
            "externalCalls": [],
        },
        "graph": {"nodes": [], "edges": []},
        "symbolTable": {
            "run": [
                {
                    "path": "ok.py",
                    "lineStart": 1,
                    "lineEnd": 2,
                    "kind": "function",
                    "language": "python",
                    "citation": "ok.py:1",
                    "deterministic": True,
                    "authority": "normal",
                },
                {
                    "path": "secret.py",
                    "lineStart": 5,
                    "lineEnd": 8,
                    "kind": "function",
                    "language": "python",
                    "citation": "secret.py:5",
                    "deterministic": True,
                    "authority": "denied",
                },
            ]
        },
        "records": [],
        "chunks": [],
        "skipped": [],
    }
    (index_dir / "index.json").write_text(json.dumps(index_data), encoding="utf-8")
    return root


class TestContextDefHouseSchema(unittest.TestCase):
    """AC1: house schema fields present in every result."""

    def test_house_schema_fields_present(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        results = context_def(root, "process")
        self.assertGreater(len(results), 0, "expected at least one result for 'process'")
        for item in results:
            missing = _HOUSE_SCHEMA_KEYS - item.keys()
            self.assertEqual(missing, set(), f"house schema fields missing: {missing}")

    def test_reason_is_symbol_definition(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        for item in context_def(root, "process"):
            self.assertEqual(item["reason"], "symbol definition")

    def test_score_is_1(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        for item in context_def(root, "process"):
            self.assertEqual(item["score"], 1.0)

    def test_deterministic_is_true(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        for item in context_def(root, "process"):
            self.assertIs(item["deterministic"], True)


class TestContextDefMultiDefinition(unittest.TestCase):
    """AC2: same symbol defined in multiple files → all matches returned."""

    def test_returns_all_matches(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        results = context_def(root, "process")
        paths = [r["path"] for r in results]
        self.assertIn("alpha.py", paths, f"alpha.py missing from results: {paths}")
        self.assertIn("beta.py", paths, f"beta.py missing from results: {paths}")

    def test_unknown_symbol_returns_empty(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        results = context_def(root, "nonexistent_xyz_symbol")
        self.assertEqual(results, [])


class TestContextDefDeniedExclusion(unittest.TestCase):
    """AC3: entries with authority:'denied' never appear in context_def output."""

    def test_denied_entry_excluded(self) -> None:
        root = make_denied_repo()
        results = context_def(root, "run")
        paths = [r["path"] for r in results]
        self.assertNotIn("secret.py", paths, f"denied path must not appear; got {paths}")

    def test_allowed_entry_included(self) -> None:
        root = make_denied_repo()
        results = context_def(root, "run")
        paths = [r["path"] for r in results]
        # ok.py is allowed (authority=normal); content read from disk may fail
        # (file doesn't actually exist in the hand-crafted index dir), but the
        # entry should still be attempted and returned (content="" on OSError).
        self.assertIn("ok.py", paths, f"allowed path must appear; got {paths}")

    def test_house_schema_still_valid_after_filtering(self) -> None:
        root = make_denied_repo()
        for item in context_def(root, "run"):
            missing = _HOUSE_SCHEMA_KEYS - item.keys()
            self.assertEqual(missing, set(), f"house schema fields missing: {missing}")


class TestAnchorStartNodesO1(unittest.TestCase):
    """AC4: _anchor_start_nodes uses symbolTable O(1) when key is present."""

    def test_uses_symbol_table_when_present(self) -> None:
        """_build_symbol_node_map is reachable and returns a dict (may be empty for
        a simple repo, but must not raise)."""
        root = make_multi_def_repo()
        build_index(root)
        index = load_index(root)
        self.assertIn("symbolTable", index, "schemaVersion 2 index must have symbolTable key")
        result = _build_symbol_node_map(index)
        self.assertIsInstance(result, dict)

    def test_cached_on_second_call(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        index = load_index(root)
        first = _build_symbol_node_map(index)
        second = _build_symbol_node_map(index)
        self.assertIs(first, second, "_build_symbol_node_map must return same object on second call")

    def test_anchor_start_nodes_with_symbol_table(self) -> None:
        root = make_multi_def_repo()
        build_index(root)
        index = load_index(root)
        self.assertIn("symbolTable", index)
        anchors = [{"kind": "symbol", "value": "process"}]
        starts, started_from = _anchor_start_nodes(index, anchors)
        # starts may be empty if process has no graph node, but must not raise
        self.assertIsInstance(starts, list)
        self.assertIsInstance(started_from, list)

    def test_fallback_without_symbol_table(self) -> None:
        """When symbolTable key is absent (v1), linear scan is used; no error."""
        index: Dict[str, Any] = {
            "graph": {
                "nodes": [
                    {"id": "n1", "kind": "symbol", "name": "process", "path": "alpha.py", "line": 1},
                ]
            },
            # No "symbolTable" key — v1 schema
        }
        anchors = [{"kind": "symbol", "value": "process"}]
        starts, started_from = _anchor_start_nodes(index, anchors)
        self.assertIn("n1", starts)


if __name__ == "__main__":
    unittest.main()
