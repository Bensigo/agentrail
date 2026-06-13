"""Chunking compatibility snapshot test (M018 AC1).

Verifies that ``symbol_aware_code_chunks`` produces chunk boundaries that match the
committed reference snapshot for a Python fixture and a TypeScript fixture.  Any
backend swap (regex → tree-sitter or vice versa) that changes chunk boundaries will
cause this test to fail, making regressions visible at CI time.

Snapshot update
---------------
Set the environment variable ``SNAPSHOT_UPDATE=1`` before running pytest to
regenerate and overwrite ``fixtures/chunking_compat_reference.json``:

    SNAPSHOT_UPDATE=1 pytest tests/context/test_chunking_compat.py -s
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List

import pytest

from agentrail.context.index import symbol_aware_code_chunks
from agentrail.context.models import Freshness, SourceRecord

FIXTURE_DIR = Path(__file__).parent / "fixtures"
REFERENCE_PATH = FIXTURE_DIR / "chunking_compat_reference.json"


def _make_source(path: str) -> SourceRecord:
    return SourceRecord(
        id=f"source:{path}",
        sourceType="code",
        path=path,
        contentHash="sha256:test",
        modifiedAt=None,
        freshness=Freshness(status="current", observedAt=None, expiresAt=None),
        authority="normal",
        visibility="visible",
        linkedIssues=[],
        linkedPullRequests=[],
        chunkIds=[],
        auditRef="",
    )


def _chunk_entries(fixture_filename: str) -> List[Dict[str, Any]]:
    """Run symbol_aware_code_chunks and return only the stable boundary fields."""
    text = (FIXTURE_DIR / fixture_filename).read_text(encoding="utf-8")
    source = _make_source(fixture_filename)
    chunks = symbol_aware_code_chunks(source, text, fixture_filename)
    return [
        {
            "id": c.id,
            "symbol": c.symbol,
            "kind": c.kind,
            "startLine": c.startLine,
            "endLine": c.endLine,
        }
        for c in chunks
    ]


def _generate_reference() -> Dict[str, List[Dict[str, Any]]]:
    return {
        "python": _chunk_entries("chunking_compat_sample.py"),
        "typescript": _chunk_entries("chunking_compat_sample.ts"),
    }


def test_chunking_compat_python_and_typescript() -> None:
    """AC1: chunk boundaries on Python and TS fixtures match the committed reference."""
    if os.environ.get("SNAPSHOT_UPDATE"):
        snapshot = _generate_reference()
        REFERENCE_PATH.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        pytest.skip("Snapshot updated — rerun without SNAPSHOT_UPDATE to verify")

    reference = json.loads(REFERENCE_PATH.read_text(encoding="utf-8"))
    actual = _generate_reference()

    assert actual["python"] == reference["python"], (
        "Python chunking boundaries differ from snapshot.\n"
        f"Expected: {reference['python']}\n"
        f"Actual:   {actual['python']}\n"
        "Run with SNAPSHOT_UPDATE=1 to regenerate."
    )
    assert actual["typescript"] == reference["typescript"], (
        "TypeScript chunking boundaries differ from snapshot.\n"
        f"Expected: {reference['typescript']}\n"
        f"Actual:   {actual['typescript']}\n"
        "Run with SNAPSHOT_UPDATE=1 to regenerate."
    )
