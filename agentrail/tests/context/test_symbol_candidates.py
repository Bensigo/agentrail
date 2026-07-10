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
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from agentrail.context import evaluation as ev
from agentrail.context.index import build_index
from agentrail.context.retrieval import context_def, load_index, query_context
from agentrail.context.symbol_candidates import (
    cross_file_imported_symbols,
    imported_symbol_candidates,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "tree_sitter"

_EXPANSION_FLAG = "AGENTRAIL_CONTEXT_QUERY_EXPANSION"


@contextmanager
def _expansion(enabled: bool):
    """Set/clear the recall-layer flag for the duration of the block.

    ``query_expansion_enabled`` reads ``os.environ`` live, so mutating it here is
    enough to flip both expansion arms on/off without re-importing anything.
    """
    prior = os.environ.get(_EXPANSION_FLAG)
    if enabled:
        os.environ[_EXPANSION_FLAG] = "1"
    else:
        os.environ.pop(_EXPANSION_FLAG, None)
    try:
        yield
    finally:
        if prior is None:
            os.environ.pop(_EXPANSION_FLAG, None)
        else:
            os.environ[_EXPANSION_FLAG] = prior

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


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_cross_import_repo() -> Path:
    """Tiny git repo where a python file AND a TS file each import a symbol that
    is DEFINED in a sibling file — the exact cross-file shape AC4 must recall."""
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_base_config(), indent=2), encoding="utf-8"
    )
    # Python: importer pulls a function + class defined in definer.py.
    _write(
        root,
        "pkgpy/definer.py",
        "def shared_widget_helper(value):\n"
        "    return value * 2\n\n\n"
        "class SharedWidgetThing:\n"
        "    def method(self):\n"
        "        return 1\n",
    )
    _write(
        root,
        "pkgpy/importer.py",
        "from pkgpy.definer import shared_widget_helper\n\n\n"
        "def use_widget(x):\n"
        "    return shared_widget_helper(x)\n",
    )
    # TypeScript: importer pulls an exported function defined in definer.ts.
    _write(
        root,
        "pkgts/definer.ts",
        "export function computeWidgetArea(radius: number): number {\n"
        "    return radius * radius;\n"
        "}\n",
    )
    _write(
        root,
        "pkgts/importer.ts",
        "import { computeWidgetArea } from './definer';\n\n"
        "export function runWidget(radius: number): number {\n"
        "    return computeWidgetArea(radius);\n"
        "}\n",
    )
    _git_init(root)
    build_index(root)
    return root


class CrossFileImportedSymbolGeneration(unittest.TestCase):
    """AC4: the generator recovers cross-file imported symbols on python AND TS."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_cross_import_repo()
        cls.index = load_index(cls.repo)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.repo, ignore_errors=True)

    def test_python_cross_file_symbol_detected(self) -> None:
        names = cross_file_imported_symbols(self.repo, self.index, ["pkgpy/importer.py"])
        self.assertIn("shared_widget_helper", names)
        # A symbol defined in the seed itself is NOT a cross-file candidate.
        self.assertNotIn("use_widget", names)
        _, items = imported_symbol_candidates(
            self.repo, self.index, ["pkgpy/importer.py"], context_def=context_def
        )
        def_paths = {i["path"] for i in items if i["symbol"] == "shared_widget_helper"}
        self.assertIn("pkgpy/definer.py", def_paths)

    def test_typescript_cross_file_symbol_detected(self) -> None:
        names = cross_file_imported_symbols(self.repo, self.index, ["pkgts/importer.ts"])
        self.assertIn("computeWidgetArea", names)
        _, items = imported_symbol_candidates(
            self.repo, self.index, ["pkgts/importer.ts"], context_def=context_def
        )
        def_paths = {i["path"] for i in items if i["symbol"] == "computeWidgetArea"}
        self.assertIn("pkgts/definer.ts", def_paths)

    def test_generation_is_deterministic(self) -> None:
        a = cross_file_imported_symbols(self.repo, self.index, ["pkgpy/importer.py"])
        b = cross_file_imported_symbols(self.repo, self.index, ["pkgpy/importer.py"])
        self.assertEqual(a, b)

    def test_empty_seed_list_is_empty(self) -> None:
        self.assertEqual(cross_file_imported_symbols(self.repo, self.index, []), [])


class ExpansionFlagGate(unittest.TestCase):
    """Flag-OFF is a strict no-op; flag-ON appends the cross-file definition."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_cross_import_repo()

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _run(self):
        return query_context(self.repo, "use_widget", limit=10)

    def test_flag_off_is_a_strict_noop(self) -> None:
        with _expansion(False):
            out1 = self._run()
            out2 = self._run()
        self.assertFalse(out1["expansion"]["enabled"])
        # No cross-file imported symbol is identified or injected when OFF.
        self.assertEqual(out1["expansion"]["symbolCandidateCount"], 0)
        # Deterministic OFF: identical result paths across runs.
        self.assertEqual(
            [r["path"] for r in out1["results"]],
            [r["path"] for r in out2["results"]],
        )

    def test_flag_on_gates_the_layer_recall_monotonically(self) -> None:
        with _expansion(False):
            off = self._run()
        with _expansion(True):
            on = self._run()
        off_paths = [r["path"] for r in off["results"]]
        on_paths = [r["path"] for r in on["results"]]
        # Gate fired: the flag turned the layer ON and it found the cross-file
        # import (shared_widget_helper, defined in pkgpy/definer.py).
        self.assertEqual(off["expansion"]["symbolCandidateCount"], 0)
        self.assertTrue(on["expansion"]["enabled"])
        self.assertGreaterEqual(on["expansion"]["symbolCandidateCount"], 1)
        # The defining file is present in the ON pack.
        self.assertIn("pkgpy/definer.py", on_paths)
        # Recall-monotone: every OFF result survives ON (the monotonicity guard
        # never lets an injected candidate evict a baseline pack member).
        self.assertTrue(set(off_paths) <= set(on_paths), f"OFF {off_paths} !<= ON {on_paths}")


# ---------------------------------------------------------------------------
# Certification (AC1) against the REAL repo corpus. Mirrors
# test_nonsaturated_fixtures: drives the live retriever over the two genuinely
# non-saturated -hard fixtures. The recall layer lifts the cross-file dependency
# whose imported symbol is a sharp (rare) identifier (context-index-build-hard:
# source_record_for_file -> sources.py) into the pack, while the monotonicity
# guard keeps recall from regressing anywhere and holds the precision head.
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).parent.parent.parent


class HardFixtureRecallCertification(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        fixtures = ev.load_fixtures(
            _REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"
        )
        cls.by_name = {fx["name"]: fx for fx in fixtures}

    def _flp(self, name: str, enabled: bool) -> dict:
        with _expansion(enabled):
            return self._evaluate(name)["metrics"]["fileLevelPrecision"]

    def _evaluate(self, name: str) -> dict:
        return ev._evaluate_fixture(_REPO_ROOT, self.by_name[name])

    def test_index_build_hard_recall_rises_precision_head_held(self) -> None:
        """AC1: the sharp cross-file dependency is recalled, precision head held."""
        off = self._flp("context-index-build-hard", False)
        on = self._flp("context-index-build-hard", True)
        self.assertAlmostEqual(off["recall"], 0.666667, places=5)
        # Recall rises toward 1.0.
        self.assertGreater(on["recall"], off["recall"])
        # Joint bar: rPrecision reported and NOT collapsing (held at least flat —
        # the recalled dependency displaces only lower-ranked keyword noise).
        self.assertIsInstance(on["rPrecision"], (int, float))
        self.assertGreaterEqual(on["rPrecision"], off["rPrecision"])
        self.assertIsInstance(on["precisionInPack"], (int, float))

    def test_no_hard_fixture_recall_regresses(self) -> None:
        """Recall-monotone: neither non-saturated fixture loses recall under ON.

        context-index-build-hard's rare imported symbol (source_record_for_file)
        is recalled by #1103's token/pattern injection; context-pack-build-hard's
        COMMON imported symbol (compute_pack_quality, ~106 chunks) is recalled by
        #1104's definition-aware tier. Both rise to 1.0; neither may fall.
        """
        for name in ("context-index-build-hard", "context-pack-build-hard"):
            with self.subTest(fixture=name):
                off = self._flp(name, False)
                on = self._flp(name, True)
                self.assertGreaterEqual(
                    on["recall"], off["recall"],
                    f"{name}: recall regressed {off['recall']} -> {on['recall']}",
                )

    def test_pack_build_hard_recall_rises_via_definition_tier(self) -> None:
        """#1104 AC1: the COMMON-symbol dependency is recalled, precision head held.

        context-pack-build-hard imports compute_pack_quality from pack_quality.py,
        but that symbol is a common token BM25 cannot single out from ~106 chunks,
        so #1103 alone leaves fileRecall at 0.5. The definition-aware tier keys on
        symbolTable identity (not token frequency) and promotes pack_quality.py's
        defining chunk, lifting recall to 1.0 while rPrecision is reported and does
        not collapse (the promotion evicts only sub-floor keyword noise).
        """
        off = self._flp("context-pack-build-hard", False)
        on = self._flp("context-pack-build-hard", True)
        self.assertAlmostEqual(off["recall"], 0.5, places=5)
        self.assertAlmostEqual(on["recall"], 1.0, places=5)
        # Joint bar: rPrecision reported and NOT collapsing below the baseline.
        self.assertIsInstance(on["rPrecision"], (int, float))
        self.assertGreaterEqual(on["rPrecision"], off["rPrecision"])
        # precisionInPack reported alongside and not collapsing (it improves here,
        # the recalled definition displacing lower-ranked keyword noise).
        self.assertIsInstance(on["precisionInPack"], (int, float))
        self.assertGreaterEqual(on["precisionInPack"], off["precisionInPack"])


if __name__ == "__main__":
    unittest.main()
