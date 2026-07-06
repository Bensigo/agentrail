"""End-to-end: symbol-granular candidates survive query_context (#1043 AC4).

The tree-sitter symbol engine (``agentrail/context/index.py``) already chunks
code per-symbol — ``symbol_aware_code_chunks`` sets ``ChunkRecord.symbol`` and
``.kind`` on each code chunk, and ``ChunkRecord.to_json()`` ALWAYS emits both
fields (models.py: "Always emitted so downstream consumers can rely on field
presence"). The recall gap AC4 closes is the LAST hop: ``query_context`` builds
its result dict (``agentrail/context/retrieval.py``) WITHOUT copying that
per-chunk symbol identity through, so a downstream consumer reading the results
cannot tell WHICH symbol a code candidate is — the symbol-granularity is thrown
away at the retrieval boundary.

This test pins the contract that closes it: for a symbol-name query, at least
one candidate ``query_context`` returns carries a non-None ``symbol`` (a real
fixture symbol name) AND a non-None ``symbolKind`` — on BOTH a python and a
TypeScript file.

RED (before the retrieval.py plumb-through): the result dict has no ``symbol`` /
``symbolKind`` keys, so ``.get("symbol")`` is ``None`` on every result and both
language assertions fail.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.retrieval import query_context

_FIXTURES = Path(__file__).parent / "fixtures" / "tree_sitter"

# Symbols the tree-sitter engine extracts from each fixture (verified against a
# real build_index). Kept language-disjoint so a query for one language's
# symbols cannot be satisfied by the other file's chunks.
_PYTHON_SYMBOLS = {"greet", "add", "Calculator", "multiply", "divide"}
_TYPESCRIPT_SYMBOLS = {"Circle", "Shape", "Color", "area", "constructor"}


def _base_config() -> dict:
    """Minimal embedding-disabled context config (lexical + graph only)."""
    return {
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled"},
            "summary": {"mode": "disabled"},
        },
    }


def _git_init(root: Path) -> None:
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@test.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)


def _make_code_repo() -> Path:
    """A tiny git repo with a built context index over the python + TS fixtures."""
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_base_config(), indent=2), encoding="utf-8"
    )
    (root / "src").mkdir()
    shutil.copy(_FIXTURES / "sample.py", root / "src" / "sample.py")
    shutil.copy(_FIXTURES / "sample.ts", root / "src" / "sample.ts")
    _git_init(root)
    build_index(root)
    return root


class SymbolCandidatesSurviveQueryContext(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_code_repo()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _symbol_carrying(self, query: str, known: set[str]) -> list[dict]:
        """query_context results whose symbol is a known fixture symbol + has a kind."""
        results = query_context(self.repo, query).get("results", [])
        return [
            r for r in results if r.get("symbol") in known and r.get("symbolKind")
        ]

    def test_python_symbol_candidate_carries_symbol_and_kind(self) -> None:
        carrying = self._symbol_carrying(
            "Calculator add multiply divide method", _PYTHON_SYMBOLS
        )
        self.assertTrue(
            carrying,
            "No query_context result for a python symbol query carried a known "
            "`symbol` + a non-None `symbolKind`. The index chunks code per-symbol "
            "(ChunkRecord.symbol/.kind), but query_context drops that identity from "
            "its result dict — AC4 (#1043) requires symbol-granular candidates to "
            "survive end-to-end through query_context.",
        )

    def test_typescript_symbol_candidate_carries_symbol_and_kind(self) -> None:
        carrying = self._symbol_carrying(
            "Circle Shape Color area interface", _TYPESCRIPT_SYMBOLS
        )
        self.assertTrue(
            carrying,
            "No query_context result for a TypeScript symbol query carried a known "
            "`symbol` + a non-None `symbolKind`. The index chunks code per-symbol "
            "(ChunkRecord.symbol/.kind), but query_context drops that identity from "
            "its result dict — AC4 (#1043) requires symbol-granular candidates to "
            "survive end-to-end through query_context.",
        )


if __name__ == "__main__":
    unittest.main()
