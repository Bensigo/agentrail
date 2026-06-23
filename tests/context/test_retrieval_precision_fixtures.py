"""Acceptance test for issue #901 — TEST-AUTHOR role (ADR 0008).

This test MUST BE RED before the Implementer acts.  Do not edit production
code here.  The Implementer turns these green by:

  1. Adding a version-controlled retrieval-fixture file (≥5 entries) at the
     documented path.
  2. Calling compute_pack_quality inside build_context_pack and attaching its
     result to the Context Pack JSON output.

What each AC pins:

  AC1 — A documented, version-controlled fixture set with ≥5 entries exists.
  AC2 — evaluate_retrieval over those fixtures produces non-zero
         precision_at_budget and required-source-inclusion coverage per
         fixture, from the Context Pack the compiler returns.
  AC3 — build_context_pack attaches precision_at_budget to the Context Pack
         JSON artifact (not absent and not always 0).
  AC4 — The metric is falsifiable: a pack built from a repo where the compiler
         can select a high-value (context_doc / required-anchor) source has a
         higher precision_at_budget than one built from a filler-only repo
         where no such source is available.

Why each test is RED before implementation:

  AC1 tests  — RETRIEVAL_FIXTURE_FILE does not exist yet.
  AC2 tests  — cascade from AC1: fixture file missing, evaluate_retrieval
               cannot run over it.
  AC3 tests  — build_context_pack never calls compute_pack_quality, so the
               pack JSON has no "precision_at_budget" key.
  AC4 tests  — pack JSON has no "precision_at_budget" key (same root cause as
               AC3); comparison raises KeyError on the first pack.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.evaluation import evaluate_retrieval, load_fixtures
from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, load_context_pack

# ---------------------------------------------------------------------------
# Canonical documented path for the repo's version-controlled fixture set.
# The Implementer creates this file; AC1 verifies its existence and shape.
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"


# ---------------------------------------------------------------------------
# Repo-building helpers (no production code here)
# ---------------------------------------------------------------------------

def _base_config(extras: dict | None = None) -> dict:
    cfg: dict = {
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
    if extras:
        cfg["context"].update(extras)
    return cfg


def _git_init(root: Path) -> None:
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@test.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)


def _make_repo_with_context_doc() -> Path:
    """Repo with CONTEXT.md (sourceType=context_doc → required/anchor).

    A pack built from this repo should have precision_at_budget > 0 because
    the context_doc tier counts as a required/high-value source.
    """
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_base_config(), indent=2), encoding="utf-8"
    )
    (root / "CONTEXT.md").write_text(
        "# Context\n\nprecision_at_budget live metrics acceptance test.\n"
        "Context Compiler retrieval quality gate.\n",
        encoding="utf-8",
    )
    (root / "src").mkdir()
    (root / "src" / "module.py").write_text(
        "# source module for pack build\ndef compute(): pass\n",
        encoding="utf-8",
    )
    _git_init(root)
    build_index(root)
    return root


def _make_filler_only_repo() -> Path:
    """Repo with no CONTEXT.md and no high-authority sources.

    The compiler has nothing required/anchor to select, so precision_at_budget
    should be lower than a repo that contains a context_doc.
    """
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_base_config(), indent=2), encoding="utf-8"
    )
    # No CONTEXT.md — only low-authority filler code
    (root / "src").mkdir()
    (root / "src" / "filler_a.py").write_text(
        "# filler A for filler-only repo\ndef filler_a(): pass\n",
        encoding="utf-8",
    )
    (root / "src" / "filler_b.py").write_text(
        "# filler B for filler-only repo\ndef filler_b(): pass\n",
        encoding="utf-8",
    )
    _git_init(root)
    build_index(root)
    return root


# ---------------------------------------------------------------------------
# AC1 — fixture set exists at the documented path with ≥5 entries
# ---------------------------------------------------------------------------

class AC1_FixtureSetExists(unittest.TestCase):
    """AC1: A version-controlled retrieval fixture set with ≥5 entries must
    exist at the documented canonical path RETRIEVAL_FIXTURE_FILE.

    All three tests are RED because the file does not exist yet.
    """

    def test_fixture_file_exists_at_documented_path(self) -> None:
        """FAILS: file not created yet."""
        self.assertTrue(
            RETRIEVAL_FIXTURE_FILE.exists(),
            f"Retrieval fixture file not found at:\n  {RETRIEVAL_FIXTURE_FILE}\n"
            "AC1 requires a version-controlled fixture set at that documented path. "
            "The Implementer must create this file.",
        )

    def test_fixture_file_has_at_least_five_fixtures(self) -> None:
        """FAILS: file not created yet (or fewer than 5 fixtures)."""
        if not RETRIEVAL_FIXTURE_FILE.exists():
            self.fail(
                f"Retrieval fixture file missing at {RETRIEVAL_FIXTURE_FILE}. "
                "AC1 requires ≥5 fixtures."
            )
        data = json.loads(RETRIEVAL_FIXTURE_FILE.read_text(encoding="utf-8"))
        fixtures = data if isinstance(data, list) else data.get("fixtures", [])
        self.assertGreaterEqual(
            len(fixtures),
            5,
            f"Fixture file contains {len(fixtures)} fixture(s); AC1 requires ≥5. "
            "Each fixture must map a distinct task/query to its required sources.",
        )

    def test_fixtures_parseable_by_load_fixtures(self) -> None:
        """FAILS: file not created yet.

        load_fixtures validates schema (task field, string-list fields,
        minPrecisionAtBudget coercion) and must not raise on the repo fixture file.
        """
        if not RETRIEVAL_FIXTURE_FILE.exists():
            self.fail(
                f"Retrieval fixture file missing at {RETRIEVAL_FIXTURE_FILE}."
            )
        fixtures = load_fixtures(RETRIEVAL_FIXTURE_FILE)
        self.assertGreaterEqual(len(fixtures), 5)
        for fixture in fixtures:
            self.assertIn("task", fixture, f"Fixture {fixture.get('name', '?')} missing 'task'")
            self.assertIn(
                "requiredSources", fixture,
                f"Fixture {fixture.get('name', '?')} missing 'requiredSources'",
            )


# ---------------------------------------------------------------------------
# AC3 — build_context_pack attaches precision_at_budget to the pack JSON
# ---------------------------------------------------------------------------

class AC3_PrecisionAttachedToPackOutput(unittest.TestCase):
    """AC3: build_context_pack must call compute_pack_quality and store its
    result on the Context Pack JSON so that telemetry/Milestone 014 can read
    precision_at_budget from the artifact.

    All tests are RED because build_context_pack never calls compute_pack_quality.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo_with_context_doc()

    def _build_and_load(self) -> dict:
        result = build_context_pack(self.repo, "issue", 1, "plan")
        return load_context_pack(self.repo, result["packId"])

    def test_pack_json_contains_precision_at_budget_key(self) -> None:
        """FAILS: pack JSON never has 'precision_at_budget' because
        build_context_pack does not call compute_pack_quality."""
        pack = self._build_and_load()
        self.assertIn(
            "precision_at_budget",
            pack,
            "Context Pack JSON is missing the 'precision_at_budget' key. "
            "AC3: build_context_pack must call compute_pack_quality and merge "
            "its output into the pack before writing the JSON artifact.",
        )

    def test_precision_at_budget_is_non_zero_when_context_doc_selected(self) -> None:
        """FAILS: field missing or 0.

        When CONTEXT.md is indexed (sourceType=context_doc) and selected by
        the compiler, compute_pack_quality must yield precision_at_budget > 0.
        The value must reflect actual retrieval, not a hardcoded constant.
        """
        pack = self._build_and_load()
        precision = pack.get("precision_at_budget", 0.0)
        self.assertGreater(
            precision,
            0.0,
            f"precision_at_budget={precision!r} on the Context Pack. "
            "Expected > 0 when CONTEXT.md (context_doc / required-anchor) is "
            "selected by the compiler. The metric must be computed from actual "
            "retrieval, not hardcoded to 0.",
        )

    def test_precision_at_budget_is_a_float_between_zero_and_one(self) -> None:
        """FAILS: field missing.

        When present, the value must be a float in [0, 1].
        """
        pack = self._build_and_load()
        self.assertIn("precision_at_budget", pack)
        precision = pack["precision_at_budget"]
        self.assertIsInstance(precision, float, "precision_at_budget must be a float")
        self.assertGreaterEqual(precision, 0.0)
        self.assertLessEqual(precision, 1.0)


# ---------------------------------------------------------------------------
# AC2 — evaluate_retrieval over the fixture file returns non-zero metrics
# ---------------------------------------------------------------------------

class AC2_EvalProducesLiveNonZeroMetrics(unittest.TestCase):
    """AC2: Running evaluate_retrieval over the fixture file must produce
    non-zero precision_at_budget and coverage per fixture.

    These tests cascade-fail from AC1 (fixture file missing), so they become
    green only after both AC1 and AC2 are implemented.
    """

    def _require_fixture_file(self) -> None:
        if not RETRIEVAL_FIXTURE_FILE.exists():
            self.fail(
                f"Retrieval fixture file missing at {RETRIEVAL_FIXTURE_FILE}. "
                "AC2 requires the AC1 fixture file to exist before eval can run."
            )

    def test_eval_runs_without_error_over_fixture_file(self) -> None:
        """FAILS: fixture file missing (cascade from AC1)."""
        self._require_fixture_file()
        # evaluate_retrieval must complete without raising; skipped fixtures
        # are acceptable (e.g. embedding-gated fixtures), but it must not crash.
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        self.assertIn("fixtures", report)
        self.assertGreater(report["summary"]["fixtures"], 0)

    def test_at_least_one_fixture_reports_non_zero_precision(self) -> None:
        """FAILS: fixture file missing (cascade from AC1).

        Among the fixtures that are not skipped, at least one must report
        precisionAtBudget.precision > 0.  This proves the metric is computed
        from real retrieval (not a hardcoded constant) and that the fixture
        file is wired correctly.
        """
        self._require_fixture_file()
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        non_skipped = [f for f in report["fixtures"] if f["status"] != "skipped"]
        self.assertTrue(
            non_skipped,
            "All fixtures were skipped; at least one must run and compute precision.",
        )
        precisions = [
            f["metrics"].get("precisionAtBudget", {}).get("precision", 0.0)
            for f in non_skipped
        ]
        self.assertTrue(
            any(p > 0.0 for p in precisions),
            f"All non-skipped fixture precisions are 0: {precisions}. "
            "AC2 requires non-zero precision computed from actual compiler retrieval.",
        )

    def test_at_least_one_fixture_reports_non_zero_required_source_coverage(self) -> None:
        """FAILS: fixture file missing (cascade from AC1).

        Among non-skipped fixtures, at least one must have at least one
        required source present in the compiler's output (coverage > 0).
        """
        self._require_fixture_file()
        report = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        non_skipped = [f for f in report["fixtures"] if f["status"] != "skipped"]
        coverages = []
        for fixture in non_skipped:
            rsi = fixture["metrics"].get("requiredSourceInclusion", {})
            required = len(rsi.get("required", []))
            missing = len(rsi.get("missing", []))
            coverage = (required - missing) / max(required, 1) if required else 0.0
            coverages.append(coverage)
        self.assertTrue(
            any(c > 0.0 for c in coverages),
            f"No fixture reported non-zero required-source coverage: {coverages}. "
            "AC2 requires coverage to reflect actual compiler selection.",
        )


# ---------------------------------------------------------------------------
# AC4 — precision_at_budget is falsifiable (moves in the correct direction)
# ---------------------------------------------------------------------------

class AC4_PackPrecisionIsFalsifiable(unittest.TestCase):
    """AC4: The metric must move in the correct direction.

    A pack built from a repo with a context_doc (CONTEXT.md = required/anchor)
    must have a higher precision_at_budget than a pack built from a repo with
    only filler sources (no context_doc, no high-authority items).

    Both tests are RED because build_context_pack does not attach
    precision_at_budget to the pack JSON (same root cause as AC3).
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_with_context_doc = _make_repo_with_context_doc()
        cls.repo_filler_only = _make_filler_only_repo()

    def _pack_precision(self, repo: Path) -> float:
        result = build_context_pack(repo, "issue", 1, "plan")
        pack = load_context_pack(repo, result["packId"])
        # KeyError here is the expected failure mode before AC3 is implemented.
        return pack["precision_at_budget"]

    def test_context_doc_repo_has_higher_precision_than_filler_only_repo(self) -> None:
        """FAILS: pack JSON missing 'precision_at_budget' (KeyError from _pack_precision).

        After AC3 is implemented:
          - precision_with_context_doc > 0  (CONTEXT.md is a required/anchor source)
          - precision_filler_only ≤ precision_with_context_doc
          (Filler items have no high-authority designation, so the token share
          of required/anchor sources is lower or zero.)
        """
        precision_with_context_doc = self._pack_precision(self.repo_with_context_doc)
        precision_filler_only = self._pack_precision(self.repo_filler_only)
        self.assertGreater(
            precision_with_context_doc,
            precision_filler_only,
            f"precision_at_budget: context_doc_repo={precision_with_context_doc} "
            f"filler_only_repo={precision_filler_only}. "
            "AC4 requires the metric to be falsifiable: repos with high-value "
            "required sources must score higher than filler-only repos. "
            "The metric must not be a constant.",
        )

    def test_filler_only_repo_precision_is_not_equal_to_context_doc_repo(self) -> None:
        """FAILS: pack JSON missing 'precision_at_budget' (KeyError).

        A necessary condition for falsifiability: the two packs must not report
        identical precision, given that their source compositions differ.
        """
        precision_with_context_doc = self._pack_precision(self.repo_with_context_doc)
        precision_filler_only = self._pack_precision(self.repo_filler_only)
        self.assertNotEqual(
            precision_with_context_doc,
            precision_filler_only,
            "Both packs report identical precision_at_budget. "
            "AC4 requires the metric to reflect real differences in source quality.",
        )


if __name__ == "__main__":
    unittest.main()
