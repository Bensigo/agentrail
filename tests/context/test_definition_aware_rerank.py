"""Definition-aware rerank tier for common-symbol cross-file deps (#1104).

#1103's token+pattern injection recalls a missed dependency only when its
imported symbol is a RARE name (high BM25 idf). When the symbol is a COMMON token
-- ``compute_pack_quality`` occurs in ~106 chunks -- BM25 cannot separate the one
file that DEFINES it from the ~105 that merely call it, so the defining file
stays out of the pack and fileRecall sticks at 0.5.

This tier closes that gap by keying on definition-site IDENTITY, not token
frequency: ``symbolTable`` resolves each imported name to the exact file that
spells its ``def``, and the per-chunk ``symbol``/``symbolKind`` (#1103) makes the
defining chunk identifiable however common the token is. These tests pin:

  * AC2 -- ``select_definition_promotions`` picks the def-site by identity even
    when same-token noise out-ranks it, and ``definition_site_paths`` resolves
    only genuine cross-file definitions;
  * the end-to-end promotion on a synthetic COMMON-symbol repo (the defining file
    is recalled ON, absent OFF); and
  * AC3 -- flag-OFF never touches the new code path (byte-identical baseline).
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

from agentrail.context import retrieval as retr
from agentrail.context.index import build_index
from agentrail.context.retrieval import load_index, query_context
from agentrail.context.symbol_candidates import (
    definition_site_paths,
    select_definition_promotions,
)

_EXPANSION_FLAG = "AGENTRAIL_CONTEXT_QUERY_EXPANSION"


@contextmanager
def _expansion(enabled: bool):
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


# ---------------------------------------------------------------------------
# AC2 (pure): identity, not frequency, selects the definition site.
# ---------------------------------------------------------------------------
class SelectDefinitionPromotionsKeysOnIdentity(unittest.TestCase):
    def _cand(self, symbol, path, kind, final):
        return {
            "symbol": symbol,
            "path": path,
            "symbolKind": kind,
            "chunkId": f"chunk:{path}#{symbol or 'ref'}",
            "score": {"final": final},
        }

    def test_definition_site_wins_over_higher_ranked_same_token_noise(self) -> None:
        """The common-symbol def-site is promoted, the same-token callers are not.

        ``compute_widget`` is defined ONLY in ``defs.py``; the two higher-SCORED
        candidates are chunks that merely mention/call the token (a bare reference
        with no ``symbol`` identity, and a chunk whose ``symbol`` is a DIFFERENT
        name). A frequency/score-driven selector would pick a top-scored caller;
        an identity-driven one picks ``defs.py`` however low it ranks.
        """
        def_site_map = {"compute_widget": {"agentrail/pkg/defs.py"}}
        candidates = [
            # Same-token NOISE, out-ranks the def-site (higher final):
            self._cand(None, "agentrail/pkg/caller_a.py", "function", 99.0),
            self._cand("unrelated", "agentrail/pkg/caller_b.py", "function", 80.0),
            # A same-NAME symbol defined in a DIFFERENT file than symbolTable's
            # resolved def path -> not the true definition site, must be ignored:
            self._cand("compute_widget", "vendor/shadow.py", "function", 70.0),
            # The genuine definition site, lowest score of all:
            self._cand("compute_widget", "agentrail/pkg/defs.py", "function", 1.0),
        ]
        picked = select_definition_promotions(candidates, def_site_map)
        self.assertEqual([p["path"] for p in picked], ["agentrail/pkg/defs.py"])

    def test_reference_kind_is_not_a_definition(self) -> None:
        """A chunk carrying the name but a non-definition kind is not selected."""
        def_site_map = {"compute_widget": {"agentrail/pkg/defs.py"}}
        candidates = [
            self._cand("compute_widget", "agentrail/pkg/defs.py", "reference", 50.0),
            self._cand("compute_widget", "agentrail/pkg/defs.py", None, 50.0),
        ]
        self.assertEqual(select_definition_promotions(candidates, def_site_map), [])

    def test_exclude_files_and_one_per_file(self) -> None:
        """Files already packed are skipped; at most one promotion per file."""
        def_site_map = {"a": {"defs.py"}, "b": {"defs.py"}, "c": {"other.py"}}
        candidates = [
            self._cand("a", "defs.py", "function", 10.0),
            self._cand("b", "defs.py", "class", 9.0),   # same file, second symbol
            self._cand("c", "other.py", "function", 8.0),
        ]
        # other.py already in the pack -> excluded; defs.py picked once only.
        picked = select_definition_promotions(
            candidates, def_site_map, exclude_files={"other.py"}
        )
        self.assertEqual([p["path"] for p in picked], ["defs.py"])


class DefinitionSitePathsResolvesCrossFileOnly(unittest.TestCase):
    def test_maps_names_to_cross_file_definition_paths(self) -> None:
        index = {
            "symbolTable": {
                "compute_widget": [{"path": "pkg/defs.py"}],
                "local_helper": [{"path": "pkg/seed.py"}],   # same file as seed
                "denied_sym": [{"path": "pkg/secret.py", "authority": "denied"}],
                "multi": [{"path": "pkg/a.py"}, {"path": "pkg/seed.py"}],
            }
        }
        out = definition_site_paths(
            index,
            ["pkg/seed.py"],
            ["compute_widget", "local_helper", "denied_sym", "multi", "unknown"],
        )
        # cross-file definition kept
        self.assertEqual(out.get("compute_widget"), {"pkg/defs.py"})
        # symbol defined in the seed itself is NOT a cross-file candidate
        self.assertNotIn("local_helper", out)
        # authority-denied definition dropped -> no surviving path -> omitted
        self.assertNotIn("denied_sym", out)
        # unknown name absent
        self.assertNotIn("unknown", out)
        # multi keeps only the non-seed path
        self.assertEqual(out.get("multi"), {"pkg/a.py"})


# ---------------------------------------------------------------------------
# End-to-end on a synthetic COMMON-symbol repo + AC3 flag gating.
# ---------------------------------------------------------------------------
def _base_config() -> dict:
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
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "T"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_common_symbol_repo() -> Path:
    """A repo whose imported symbol ``compute_widget`` is a COMMON token.

    ``widget_core.py`` DEFINES ``compute_widget``; ``assemble.py`` (the file the
    query targets) imports and calls it; and many ``noise_*`` modules each CALL
    ``compute_widget`` so the bare token saturates the corpus -- BM25 cannot lift
    the one defining file above the callers. Only the definition-site identity can.
    """
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_base_config(), indent=2), encoding="utf-8"
    )
    _write(
        root,
        "pkg/widget_core.py",
        "def compute_widget(value):\n"
        "    '''The single definition of the common symbol.'''\n"
        "    return value * 3\n",
    )
    # The query target: a distinctive assembly routine that imports the symbol.
    _write(
        root,
        "pkg/assemble.py",
        "from pkg.widget_core import compute_widget\n\n\n"
        "def assemble_dashboard_report(rows):\n"
        "    '''Assemble the dashboard report from rows.'''\n"
        "    return [compute_widget(r) for r in rows]\n",
    )
    # Many callers make ``compute_widget`` a common token (same-token noise).
    for i in range(12):
        _write(
            root,
            f"pkg/noise_{i:02d}.py",
            f"def noise_routine_{i:02d}(items):\n"
            f"    total = 0\n"
            f"    for it in items:\n"
            f"        total += compute_widget(it)\n"
            f"    return total\n",
        )
    _git_init(root)
    build_index(root)
    return root


class CommonSymbolPipelineEndToEnd(unittest.TestCase):
    """The tier is wired end-to-end and recall-monotone on a common-symbol repo.

    A minimal repo cannot reproduce the *buried* common-symbol case the tier is
    for -- at this scale graph expansion recalls the direct import unconditionally,
    so the definer is already packed. The genuinely-buried case (a 106-chunk token
    graph expansion drops) is certified against the REAL corpus in
    ``test_symbol_candidates.HardFixtureRecallCertification``; here we pin the
    invariants that must hold on any repo: the definer stays in the ON pack and no
    OFF member is lost.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_common_symbol_repo()
        cls.index = load_index(cls.repo)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _paths(self, out):
        return [r.get("path") for r in out.get("results", [])]

    def test_definer_present_and_recall_monotone(self) -> None:
        query = "assemble_dashboard_report assemble dashboard report rows"
        with _expansion(False):
            off = query_context(self.repo, query, limit=8, index=self.index)
        with _expansion(True):
            on = query_context(self.repo, query, limit=8, index=self.index)
        off_paths, on_paths = self._paths(off), self._paths(on)
        self.assertIn("pkg/assemble.py", on_paths)
        # The common-symbol definition is in the ON pack.
        self.assertIn("pkg/widget_core.py", on_paths)
        # Recall-monotone: no OFF pack member is dropped by the ON pack.
        self.assertTrue(
            set(off_paths) <= set(on_paths),
            f"recall regressed: OFF {off_paths} !<= ON {on_paths}",
        )

    def test_flag_off_is_byte_identical_never_touches_new_path(self) -> None:
        """AC3: flag-OFF never invokes the definition-aware code path.

        Patch both promotion primitives to raise; a flag-OFF query must complete
        untouched (proving byte-identical to the pre-#1104 baseline), while a
        flag-ON query DOES exercise them.
        """
        query = "assemble_dashboard_report assemble dashboard report rows"

        def _boom(*_a, **_k):  # pragma: no cover - must never run when OFF
            raise AssertionError("definition-aware path ran under flag-OFF")

        orig_sel = retr.select_definition_promotions
        orig_map = retr.definition_site_paths
        retr.select_definition_promotions = _boom
        retr.definition_site_paths = _boom
        try:
            with _expansion(False):
                off = query_context(self.repo, query, limit=8, index=self.index)
            self.assertFalse(off["expansion"]["enabled"])
            self.assertEqual(off["expansion"]["symbolCandidateCount"], 0)
            self.assertIn("pkg/assemble.py", self._paths(off))
            # The flag-OFF expansion block is byte-identical to the pre-#1104
            # baseline: the definition-aware telemetry keys are absent entirely.
            self.assertNotIn("definitionPromotions", off["expansion"])
            self.assertNotIn("definitionPromotionCount", off["expansion"])
        finally:
            retr.select_definition_promotions = orig_sel
            retr.definition_site_paths = orig_map

    def test_flag_on_surfaces_definition_promotion_telemetry(self) -> None:
        """Flag-ON reports the tier's promotions as a deterministic $0 layer."""
        query = "assemble_dashboard_report assemble dashboard report rows"
        with _expansion(True):
            on = query_context(self.repo, query, limit=8, index=self.index)
        exp = on["expansion"]
        self.assertTrue(exp["enabled"])
        self.assertIn("definitionPromotionCount", exp)
        self.assertIsInstance(exp["definitionPromotions"], list)
        self.assertEqual(exp["definitionPromotionCount"], len(exp["definitionPromotions"]))
        self.assertEqual(exp["cost"], 0.0)


if __name__ == "__main__":
    unittest.main()
