"""Tests for PR 3 of the Repo Wiki arc (spec 2026-07-23), delivery plan S7
row 3: wiki_doc authority tier + freshness demotion in retrieval scoring
(agentrail/context/retrieval.py), the S4.7 authority-guard pin, and the
orientation-probes fixture file.

The repoOverview pack-section tests (present+capped flag-ON / absent
flag-OFF byte-identical, likelyDocs bucketing) live in test_packs.py
alongside the rest of packs.py's coverage; this file covers the
retrieval-scoring and evaluation-harness half of PR 3's scope:

  * authority tier "generated" -- score_authority/authority_demotion pin,
    plus an end-to-end query_context check that wiki_doc results actually
    carry it and flow through with a "generated source" reason.
  * stale-wiki freshness demotion -- wiki_page_freshness pin, plus an
    end-to-end check against a real compiled wiki whose manifest is made to
    disagree with the current index (the realistic staleness trigger once
    server hydration, spec PR 4, lands: a page pulled from the server can lag
    local disk).
  * spec S4.7's safety invariant: a wiki page can never satisfy a
    required-source/expected-file that names a code path, because
    evaluation's requiredSourceInclusion matches on the RESULT'S OWN record
    path, never on a path merely CITED inside a wiki page's content.
  * agentrail/context/orientation-probes.json loads and evaluates green with
    the wiki flag OFF (today's baseline).

Reuses test_wiki.py's repo/mock-provider fixtures (make_repo, _wiki_on,
_write_mock, _env) rather than duplicating them.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

from agentrail.context.evaluation import _evaluate_fixture, _included_paths, evaluate_retrieval, load_fixtures
from agentrail.context.index import build_index, load_index
from agentrail.context.retrieval import (
    authority_demotion,
    freshness_demotion,
    query_context,
    score_authority,
    wiki_page_freshness,
)
from agentrail.tests.context.test_wiki import _env, _wiki_on, _write_mock, make_repo

REPO_ROOT = Path(__file__).parent.parent.parent.parent
ORIENTATION_PROBES_FILE = REPO_ROOT / "agentrail" / "context" / "orientation-probes.json"


# ---------------------------------------------------------------------------
# Authority tier "generated" -- pure scoring pin (spec S3 "Authority", S4.7)
# ---------------------------------------------------------------------------


def _net_authority(record: Dict[str, Any]) -> float:
    """The authority contribution to score.final: +boost, -demotion (see the
    scoring loop in retrieval.py: ``final = relevance + authorityBoost -
    authorityDemotion - ...``)."""
    return score_authority(record) - authority_demotion(record)


class AuthorityTierScoringTests(unittest.TestCase):
    def test_generated_gets_no_authority_boost(self) -> None:
        """wiki_doc/"generated" must never earn the critical/high boost."""
        self.assertEqual(score_authority({"authority": "generated"}), 0.0)

    def test_generated_is_demoted_relative_to_normal(self) -> None:
        """"generated" carries a nonzero demotion; the untagged/"normal"
        default (code, context_doc before its critical override, etc.)
        carries none -- this nonzero gap is what breaks a score TIE in favor
        of the code/doc source (spec: "a wiki_doc can never outrank an
        equally-matched code/doc source")."""
        self.assertGreater(authority_demotion({"authority": "generated"}), 0.0)
        self.assertEqual(authority_demotion({"authority": "normal"}), 0.0)
        self.assertEqual(authority_demotion({}), 0.0)

    def test_generated_demotion_below_low_authority(self) -> None:
        """Compiled-and-cited wiki prose is not "low-trust" -- keep its
        demotion strictly smaller than the "low" authority tier's."""
        self.assertLess(
            authority_demotion({"authority": "generated"}),
            authority_demotion({"authority": "low"}),
        )

    def test_wiki_doc_never_outranks_equally_matched_code_or_doc_source(self) -> None:
        """The exact invariant, computed the same way the scoring loop does:
        given IDENTICAL relevance (lexical + semantic + rrf), a "generated"
        record's net authority contribution is strictly lower than a "normal"
        code/doc record's, so its score.final can never tie-or-beat an
        equally-relevant code/doc candidate."""
        relevance = 7.25  # arbitrary, shared "equally-matched" relevance
        wiki_final = relevance + _net_authority({"authority": "generated"})
        code_final = relevance + _net_authority({"authority": "normal"})
        context_doc_final = relevance + _net_authority({"authority": "critical"})
        self.assertLess(wiki_final, code_final)
        self.assertLess(wiki_final, context_doc_final)

    def test_denied_still_outranks_nothing_generated_is_not_denied(self) -> None:
        """Sanity: "generated" must not accidentally collide with the
        exclusion tier -- a wiki page stays a normal (demoted, not excluded)
        retrieval candidate."""
        self.assertLess(authority_demotion({"authority": "generated"}), 999.0)


# ---------------------------------------------------------------------------
# Stale-wiki freshness demotion -- pure pin (spec S4.3 "existing freshness-
# demotion machinery ... demotes stale pages", S4.7)
# ---------------------------------------------------------------------------


class StaleWikiFreshnessTests(unittest.TestCase):
    def test_stale_wiki_page_demoted_with_reason(self) -> None:
        record = {"sourceType": "wiki_doc", "path": ".agentrail/context/wiki/overview.md"}
        demotion, reasons = wiki_page_freshness(record, {".agentrail/context/wiki/overview.md"})
        self.assertGreater(demotion, 0.0)
        self.assertIn("stale wiki page", reasons)

    def test_fresh_wiki_page_not_in_stale_set_is_untouched(self) -> None:
        record = {"sourceType": "wiki_doc", "path": ".agentrail/context/wiki/overview.md"}
        demotion, reasons = wiki_page_freshness(record, {".agentrail/context/wiki/unit__other.md"})
        self.assertEqual(demotion, 0.0)
        self.assertEqual(reasons, [])

    def test_no_stale_set_is_a_no_op(self) -> None:
        record = {"sourceType": "wiki_doc", "path": ".agentrail/context/wiki/overview.md"}
        self.assertEqual(wiki_page_freshness(record, None), (0.0, []))
        self.assertEqual(wiki_page_freshness(record, set()), (0.0, []))

    def test_non_wiki_doc_records_are_never_touched(self) -> None:
        """A code/doc record whose path happens to collide with a stale-set
        entry (should never happen in practice -- wiki paths live under
        .agentrail/context/wiki/ -- but pin the sourceType guard anyway)."""
        record = {"sourceType": "code", "path": ".agentrail/context/wiki/overview.md"}
        demotion, reasons = wiki_page_freshness(record, {".agentrail/context/wiki/overview.md"})
        self.assertEqual((demotion, reasons), (0.0, []))

    def test_freshness_demotion_threads_stale_wiki_paths_through(self) -> None:
        """freshness_demotion (the function the scoring loop actually calls)
        must fold wiki_page_freshness's result into its own, mirroring how it
        already folds memory_freshness in."""
        record = {"sourceType": "wiki_doc", "path": ".agentrail/context/wiki/overview.md", "freshness": {"status": "current"}}
        demotion, reasons = freshness_demotion(record, None, {".agentrail/context/wiki/overview.md"})
        self.assertGreaterEqual(demotion, 1.5)
        self.assertIn("stale wiki page", reasons)

    def test_freshness_demotion_default_param_is_backward_compatible(self) -> None:
        """The two OTHER freshness_demotion call sites (apply_graph_expansion_policy,
        _lesson_target_hints) never pass stale_wiki_paths -- the default must
        keep their behavior byte-identical (no wiki demotion applied)."""
        record = {"sourceType": "wiki_doc", "path": ".agentrail/context/wiki/overview.md", "freshness": {"status": "current"}}
        demotion, reasons = freshness_demotion(record, None)
        self.assertEqual((demotion, reasons), (0.0, []))


# ---------------------------------------------------------------------------
# End-to-end: wiki_doc records flow through query_context with the right
# authority tier and reason (spec S3 "Pack integration": "Unit pages become
# rank-eligible wiki_doc retrieval candidates")
# ---------------------------------------------------------------------------


class QueryContextWikiIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.mkdtemp()
        mock_command = _write_mock(Path(cls._tmp))
        cls.root = make_repo(summary_mode="custom-command", summary_command=mock_command)
        with _wiki_on():
            build_index(cls.root)

    def test_wiki_doc_results_carry_generated_authority_and_reason(self) -> None:
        with _wiki_on():
            result = query_context(self.root, "pkg_a mod1 run_mod1 do_work responsibility structure", limit=20)
        wiki_results = [item for item in result["results"] if item.get("sourceType") == "wiki_doc"]
        self.assertTrue(wiki_results, "expected at least one wiki_doc candidate in query_context results")
        for item in wiki_results:
            self.assertEqual(item["authority"], "generated")
            score = item.get("score") or {}
            # authorityDemotion is the SAME 0.2 pinned in AuthorityTierScoringTests.
            self.assertAlmostEqual(score.get("authorityDemotion", 0.0), 0.2)
            self.assertIn("generated source", item.get("reason", ""))

    def test_wiki_doc_path_lives_under_wiki_dir_never_a_code_path(self) -> None:
        """Structural half of the S4.7 guard: every wiki_doc record's OWN
        path is under .agentrail/context/wiki/, so it is definitionally
        distinct from any real code path it may cite in its content."""
        index_data = load_index(self.root)
        wiki_records = [r for r in index_data["records"] if r.get("sourceType") == "wiki_doc"]
        self.assertTrue(wiki_records)
        for record in wiki_records:
            self.assertTrue(record["path"].startswith(".agentrail/context/wiki/"), record["path"])


# ---------------------------------------------------------------------------
# End-to-end: a manifest/frontmatter-stale wiki page is demoted with a
# visible reason when it is retrieved (spec S4.3/S4.7)
# ---------------------------------------------------------------------------


class StaleWikiIntegrationTests(unittest.TestCase):
    def test_stale_wiki_page_demoted_in_live_query(self) -> None:
        tmp = tempfile.mkdtemp()
        mock_command = _write_mock(Path(tmp))
        root = make_repo(summary_mode="custom-command", summary_command=mock_command)
        with _wiki_on():
            build_index(root)

        # Simulate the staleness spec S4.3 describes (a page whose recorded
        # inputsHash no longer matches the unit's current file hashes -- the
        # trigger hydration/PR4 introduces for real: a server-pulled page can
        # lag local disk). wiki_status() recomputes "current" hashes from the
        # index that was JUST built above, so corrupting the manifest's
        # recorded hash for one page is a faithful, deterministic way to
        # force wiki_status to report it stale without needing a second
        # index build or real time to pass.
        manifest_path = root / ".agentrail" / "context" / "wiki" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        pages = manifest["pages"]
        unit_a_entry = next(p for p in pages if p["slug"] == "wiki/unit/pkg-a")
        unit_a_entry["inputsHash"] = "sha256:deliberately-wrong-to-force-stale"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        # Pre-load the index and pass it explicitly: query_context(index=None)
        # would otherwise call build_index() itself, which (wiki_enabled=True
        # skips the content-hash cache shortcut) re-runs compile_wiki -- and
        # since the WIKI PAGE FILE's own frontmatter hash was never touched
        # (only manifest.json was), compile_wiki reuses it unchanged and
        # rewrites manifest.json with the CORRECT hash again, silently
        # clobbering the staleness this test just manufactured.
        index_data = load_index(root)

        with _wiki_on():
            from agentrail.context.wiki import wiki_status

            status = wiki_status(root)
            stale_slugs = {p["slug"] for p in status["pages"] if p["stale"]}
            self.assertIn("wiki/unit/pkg-a", stale_slugs, "test setup: manifest corruption must produce a stale page")

            result = query_context(root, "pkg_a mod1 run_mod1 do_work responsibility structure", limit=20, index=index_data)

        pkg_a_page_path = ".agentrail/context/wiki/unit__pkg-a.md"
        pkg_a_results = [item for item in result["results"] if item.get("path") == pkg_a_page_path]
        self.assertTrue(pkg_a_results, "expected the (now stale) pkg-a wiki page in query_context results")
        for item in pkg_a_results:
            self.assertIn("stale wiki page", item.get("reason", ""))
            score = item.get("score") or {}
            self.assertGreaterEqual(score.get("freshnessDemotion", 0.0), 1.5)


# ---------------------------------------------------------------------------
# S4.7 guard pin: requiredSourceInclusion matches on the RESULT'S OWN record
# path, never on a path merely cited inside a wiki page's content
# ---------------------------------------------------------------------------


class WikiCannotSatisfyCodePathRequiredSourceTests(unittest.TestCase):
    def test_included_paths_use_record_path_not_cited_content(self) -> None:
        """Pure pin, no I/O: _included_paths (the exact function
        requiredSourceInclusion's missing-source check reads) returns the
        candidate's OWN `path` field. A wiki page whose `content` cites
        `agentrail/context/packs.py` verbatim must not make that string
        appear in the returned path list -- only a result whose own `path`
        equals it would."""
        fake_query = {
            "compiler": {
                "tokenPack": {"selectedCandidateIds": ["wiki-candidate-1"]},
                "candidates": [
                    {
                        "id": "wiki-candidate-1",
                        "kind": "wiki_doc",
                        "sourceType": "wiki_doc",
                        "path": ".agentrail/context/wiki/unit__agentrail-context.md",
                        "citation": ".agentrail/context/wiki/unit__agentrail-context.md",
                        "content": (
                            "## Key files\n"
                            "- agentrail/context/packs.py — builds and renders context packs.\n"
                        ),
                    }
                ],
            }
        }
        fake_results: List[Dict[str, Any]] = []  # _included_paths prefers the compiler path when present
        included = _included_paths(fake_query, fake_results)
        self.assertEqual(included, [".agentrail/context/wiki/unit__agentrail-context.md"])
        self.assertNotIn("agentrail/context/packs.py", included)

    def test_fixture_requiring_packs_py_fails_when_only_a_citing_wiki_page_is_retrieved(self) -> None:
        """Full-pipeline pin: a fixture with requiredSources=["agentrail/context/packs.py"]
        evaluated against a query_context result set that contains ONLY a
        wiki page citing that path (never the real file) must FAIL
        requiredSourceInclusion -- never be satisfied by the citation."""
        fixture = {
            "name": "s47-guard-pin",
            "task": "how does a context pack get built",
            "limit": 10,
            "requiredSources": ["agentrail/context/packs.py"],
            "optionalProviderEnv": [],
            "minPrecisionAtBudget": 0.0,
            "expectedFiles": [],
            "expectedDocs": [],
            "expectedMemory": [],
            "expectedPriorMistakes": [],
            "expectedExcludedSources": [],
            "expectedGraphExpandedSources": [],
        }
        fake_wiki_result = {
            "results": [
                {
                    "rank": 1,
                    "path": ".agentrail/context/wiki/unit__agentrail-context.md",
                    "sourceType": "wiki_doc",
                    "citation": ".agentrail/context/wiki/unit__agentrail-context.md",
                    "reason": "generated source; BM25 keyword match",
                    "content": "## Key files\n- agentrail/context/packs.py — builds and renders context packs.\n",
                    "score": {"final": 5.0},
                }
            ],
            "excluded": [],
            "provider": {"mode": "disabled"},
            "compiler": None,
        }
        tmp_root = Path(tempfile.mkdtemp())
        (tmp_root / ".agentrail").mkdir()
        (tmp_root / ".agentrail" / "config.json").write_text(
            json.dumps({"schemaVersion": 1, "context": {"embedding": {"mode": "disabled"}}}),
            encoding="utf-8",
        )
        with mock.patch("agentrail.context.evaluation.query_context", return_value=fake_wiki_result):
            report = _evaluate_fixture(tmp_root, fixture)
        self.assertEqual(report["status"], "failed")
        self.assertIn("agentrail/context/packs.py", report["metrics"]["requiredSourceInclusion"]["missing"])
        self.assertTrue(
            any("agentrail/context/packs.py" in failure for failure in report["failures"]),
            report["failures"],
        )


# ---------------------------------------------------------------------------
# Orientation probes fixture file (spec S6 item 2): loads, and evaluates
# green with the wiki flag OFF -- today's baseline the wiki arm is compared
# against later.
# ---------------------------------------------------------------------------


class OrientationProbesFixtureTests(unittest.TestCase):
    def test_fixture_file_exists(self) -> None:
        self.assertTrue(
            ORIENTATION_PROBES_FILE.exists(),
            f"orientation-probes.json not found at {ORIENTATION_PROBES_FILE}",
        )

    def test_fixture_has_five_natural_language_probes(self) -> None:
        fixtures = load_fixtures(ORIENTATION_PROBES_FILE)
        self.assertEqual(len(fixtures), 5)
        for fixture in fixtures:
            self.assertIn("task", fixture)
            self.assertIn("requiredSources", fixture)
            self.assertEqual(len(fixture["requiredSources"]), 1, f"{fixture['name']}: requiredSources must be the single most load-bearing file")
            self.assertEqual(fixture["limit"], 10)
            # NL, not a keyword bag: a real question, not a bare symbol/path list.
            self.assertIn(" ", fixture["task"].strip())
            self.assertGreater(len(fixture["task"].split()), 4)

    def test_orientation_probes_evaluate_green_with_flag_off(self) -> None:
        """Must run green TODAY with AGENTRAIL_CONTEXT_REPO_WIKI unset (the
        default) -- these baseline current retrieval; the wiki arm is
        compared against this baseline later (spec S6 item 2)."""
        with _env("AGENTRAIL_CONTEXT_REPO_WIKI", None):
            report = evaluate_retrieval(REPO_ROOT, ORIENTATION_PROBES_FILE)
        failed = [f["name"] for f in report["fixtures"] if f["status"] == "failed"]
        self.assertEqual(failed, [], f"orientation probes must all pass flag-OFF; failures: {json.dumps([f for f in report['fixtures'] if f['status'] == 'failed'], indent=2, default=str)}")
        for fixture in report["fixtures"]:
            self.assertTrue(fixture["metrics"]["requiredSourceInclusion"]["passed"], fixture["name"])


if __name__ == "__main__":
    unittest.main()
