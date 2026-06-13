"""Tests for schemaVersion 1 → 2 migration in load_index (issue #583).

AC3: load_index on a schemaVersion 1 fixture returns without raising, and
     the returned object has symbolTable == {}.
AC5: pytest tests/context/test_schema_migration.py passes — fixture loads a
     hand-crafted schemaVersion 1 index.json and asserts empty symbolTable,
     no error, and schemaVersion in the loaded object is 1 (legacy, untouched).
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from agentrail.context.index import load_index


_V1_INDEX = {
    "schemaVersion": 1,
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
    "records": [],
    "chunks": [],
    "skipped": [],
    # NOTE: no "symbolTable" key — this is a valid v1 index
}


def _write_v1_index(root: Path) -> Path:
    index_dir = root / ".agentrail" / "context" / "index"
    index_dir.mkdir(parents=True, exist_ok=True)
    index_path = index_dir / "index.json"
    index_path.write_text(json.dumps(_V1_INDEX), encoding="utf-8")
    return index_path


class TestSchemaV1Migration:
    """load_index on a v1 index must return gracefully with symbolTable={}."""

    def test_load_v1_index_does_not_raise(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_v1_index(root)
            data = load_index(root)  # must not raise
            assert data is not None

    def test_load_v1_index_returns_empty_symbol_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_v1_index(root)
            data = load_index(root)
            assert "symbolTable" in data, "symbolTable must be present in loaded data"
            assert data["symbolTable"] == {}, f"symbolTable must be {{}} for v1 index, got {data['symbolTable']!r}"

    def test_load_v1_index_schema_version_is_1(self) -> None:
        """schemaVersion in the raw loaded data must remain 1 (not mutated)."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_v1_index(root)
            data = load_index(root)
            assert data["schemaVersion"] == 1, (
                f"schemaVersion must remain 1 for a v1 fixture; got {data['schemaVersion']!r}"
            )

    def test_load_v1_index_no_calls_edges_required(self) -> None:
        """Missing 'calls' edges in graph must not cause an error."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_v1_index(root)
            data = load_index(root)
            # graph.edges may be empty — that's fine
            edges = (data.get("graph") or {}).get("edges") or []
            calls_edges = [e for e in edges if e.get("kind") == "calls"]
            assert calls_edges == [], f"Expected no calls edges in v1 fixture, got {calls_edges!r}"
