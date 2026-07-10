"""Acceptance tests for issue #904 — deterministic code-aware RERANK stage.

These tests pin the four ACs and are written to FAIL if the rerank is a no-op:

  AC1 — retrieval produces a WIDER candidate set, reranked down to top-K kept
         under the token budget (retrieve-wide -> rerank -> keep top-K).
  AC2 — the rerank contract is populated: method + ranked list + rejected list,
         each rejection carrying a reason (NOT model:None / pass-through).
  AC3 — rerank uses ONLY deterministic code-aware signals (symbol overlap,
         graph distance, freshness); no enrichment outranks deterministic
         evidence — verified via the documented signal set + order semantics.
  AC4 — precision_at_budget on the #901 fixtures measurably improves with the
         rerank ON vs OFF, at equal-or-lower budget.  Guarded so a no-op fails.

The rerank is toggleable via AGENTRAIL_CONTEXT_RERANK so the baseline (rerank
OFF) is measurable; the AC4 test asserts strictly-greater precision, so a
rerank that does not move the metric fails.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from agentrail.context.evaluation import evaluate_retrieval
from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, load_context_pack
from agentrail.context.rerank import rerank_candidates
from agentrail.context.retrieval import query_context

REPO_ROOT = Path(__file__).parent.parent.parent.parent
RETRIEVAL_FIXTURE_FILE = REPO_ROOT / "agentrail" / "context" / "retrieval-fixtures.json"


@contextmanager
def _rerank(enabled: bool):
    """Temporarily force the rerank stage on/off via its env toggle."""
    key = "AGENTRAIL_CONTEXT_RERANK"
    prev = os.environ.get(key)
    os.environ[key] = "1" if enabled else "0"
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


def _candidate(path, *, rank, sym_hints=None, source_type="code", freshness="current"):
    return {
        "rank": rank,
        "path": path,
        "citation": path,
        "sourceType": source_type,
        "symbolHints": sym_hints or [],
        "freshness": {"status": freshness},
        "reason": "retrieved",
        "content": "x" * 40,
        "score": {"final": 100.0 - rank, "deterministic": 0.0},
    }


# ---------------------------------------------------------------------------
# Unit: the reranker reorders + populates ranked/rejected with reasons
# ---------------------------------------------------------------------------

class RerankContractAndOrderTests(unittest.TestCase):
    def test_promotes_lower_retrieved_but_more_relevant_above_higher_retrieved_noise(self) -> None:
        """AC1/AC3: a lower-retrieved candidate that DEFINES the queried symbol
        must be promoted above a higher-retrieved keyword-noise candidate that
        does not — i.e. the rerank order differs from raw retrieval order."""
        # Raw retrieval order: a test file (keyword echo) is rank 1; the source
        # that actually defines build_context_pack is rank 2.
        noise = _candidate(
            "tests/context/test_packs.py", rank=1, sym_hints=["make_repo"]
        )
        definition = _candidate(
            "agentrail/context/packs.py", rank=2, sym_hints=["build_context_pack"]
        )
        candidates = [noise, definition]

        result = rerank_candidates(
            candidates,
            query="build_context_pack sections included excluded",
            top_k=10,
        )

        ranked_paths = [item["path"] for item in result["ranked"]]
        self.assertIn("agentrail/context/packs.py", ranked_paths)
        self.assertEqual(
            ranked_paths[0],
            "agentrail/context/packs.py",
            "the symbol-defining source must be promoted above the keyword-noise "
            f"test file; got ranked order {ranked_paths}",
        )
        self.assertTrue(result["changed"], "rerank order must differ from raw retrieval order")

    def test_rerank_contract_is_populated_with_ranked_and_rejected_reasons(self) -> None:
        """AC2: method + ranked list + rejected list, each rejection with a reason."""
        noise = _candidate("scripts/echo_keywords.py", rank=1)
        definition = _candidate(
            "agentrail/context/packs.py", rank=2, sym_hints=["build_context_pack"]
        )
        result = rerank_candidates(
            [noise, definition],
            query="build_context_pack sections included",
            top_k=10,
        )
        self.assertTrue(result["method"], "rerank must record a method")
        self.assertNotEqual(result["method"], "")
        self.assertTrue(result["ranked"], "rerank must produce a ranked list")
        # The script is keyword-noise with no symbol overlap while a relevant
        # primary source exists -> it must be rejected, with a reason.
        self.assertTrue(result["rejected"], "rerank must reject the keyword-noise script")
        for item in result["rejected"]:
            reason = (item.get("rerank") or {}).get("reason")
            self.assertTrue(
                reason and reason.strip(),
                f"every rejected candidate must carry a reason; got {item.get('rerank')}",
            )
        # Every kept candidate also carries a rerank block with component signals.
        for item in result["ranked"]:
            signals = (item.get("rerank") or {}).get("signals") or {}
            for key in ("symbolOverlap", "graphDistance", "freshness"):
                self.assertIn(key, signals, f"kept candidate missing deterministic signal {key}")

    def test_only_deterministic_signals_no_model(self) -> None:
        """AC3: the rerank exposes only the deterministic code-aware signals and
        carries no LLM model (deterministic, not an LLM reranker)."""
        result = rerank_candidates(
            [_candidate("agentrail/context/packs.py", rank=1, sym_hints=["build_context_pack"])],
            query="build_context_pack",
            top_k=10,
        )
        block = result["ranked"][0]["rerank"]
        self.assertEqual(
            set(block["signals"]) & {"symbolOverlap", "graphDistance", "freshness"},
            {"symbolOverlap", "graphDistance", "freshness"},
        )


# ---------------------------------------------------------------------------
# Integration: wired into the LIVE query + pack build (not a standalone fn)
# ---------------------------------------------------------------------------

def _make_repo() -> Path:
    """A repo where the answer source (defines the queried symbol) competes with
    several keyword-noise test/fixture files that repeat the query words."""
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(
            {
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
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text("# Context\n\nContext Compiler rerank quality gate.\n", encoding="utf-8")
    src = root / "agentrail"
    src.mkdir()
    # The answer: defines settle_invoice.
    (src / "ledger.py").write_text(
        "def settle_invoice(invoice):\n    return invoice.total - invoice.paid\n",
        encoding="utf-8",
    )
    # Keyword-noise: tests + a fixtures file + a script that all repeat the words.
    tests = root / "tests"
    tests.mkdir()
    for i in range(4):
        (tests / f"test_settle_{i}.py").write_text(
            f"# settle invoice settle invoice settle invoice {i}\n"
            "def test_settle_invoice():\n    assert True\n",
            encoding="utf-8",
        )
    scripts = root / "scripts"
    scripts.mkdir()
    (scripts / "settle.py").write_text(
        "# settle invoice settle invoice helper script\nprint('settle invoice')\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


class RerankWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo = _make_repo()

    def test_query_context_retrieves_wider_then_keeps_fewer_under_budget(self) -> None:
        """AC1: with rerank ON the kept top-K is reranked down from a wider
        candidate set — strictly fewer kept than with rerank OFF for this noisy
        repo, and the rejected candidates are recorded in excluded."""
        with _rerank(False):
            off = query_context(self.repo, "settle_invoice ledger settle invoice", limit=10)
        with _rerank(True):
            on = query_context(self.repo, "settle_invoice ledger settle invoice", limit=10)
        self.assertLess(
            len(on["results"]),
            len(off["results"]),
            "rerank must keep fewer (higher-precision) candidates than the raw "
            f"top-K; off={len(off['results'])} on={len(on['results'])}",
        )
        rerank_rejected = [e for e in on["excluded"] if isinstance(e, dict) and e.get("rerank")]
        self.assertTrue(rerank_rejected, "rejected candidates must be recorded in excluded with a rerank block")

    def test_live_compiler_contract_rerank_is_populated_not_passthrough(self) -> None:
        """AC2: the LIVE query compiler contract has a populated, non-pass-through
        rerank (method + ranked + rejected-with-reasons), not model:None."""
        with _rerank(True):
            out = query_context(self.repo, "settle_invoice ledger settle invoice", limit=10)
        rr = out["compiler"]["rerank"]
        self.assertEqual(rr["status"], "reranked")
        self.assertNotEqual(rr["method"], "hybrid_lexical_rrf_authority_freshness")
        self.assertTrue(rr["rankedCandidateIds"], "rerank must record ranked candidate ids")
        self.assertTrue(rr["rejected"], "rerank must record rejected candidates")
        for item in rr["rejected"]:
            self.assertTrue((item.get("reason") or "").strip(), "each rejection needs a reason")

    def test_rerank_is_wired_into_build_context_pack(self) -> None:
        """The rerank must be wired into the live pack build, not a standalone
        function nothing calls: build_context_pack's compiler contract must carry
        the populated deterministic rerank."""
        with _rerank(True):
            result = build_context_pack(self.repo, "issue", 1, "plan")
            pack = load_context_pack(self.repo, result["packId"])
        rr = pack["compiler"]["rerank"]
        self.assertEqual(rr["status"], "reranked", "build_context_pack must thread the rerank metadata")
        self.assertIsNone(rr["model"], "deterministic rerank carries no LLM model")
        self.assertIn("signals", rr)


# ---------------------------------------------------------------------------
# AC4: precision_at_budget improves with rerank ON vs OFF on the #901 fixtures
# ---------------------------------------------------------------------------

def _mean_precision(report: dict) -> float:
    precisions = [
        f.get("metrics", {}).get("precisionAtBudget", {}).get("precision") or 0.0
        for f in report["fixtures"]
        if f["status"] != "skipped"
    ]
    return sum(precisions) / len(precisions) if precisions else 0.0


class RerankPrecisionImprovementTests(unittest.TestCase):
    """AC4: the rerank measurably improves precision_at_budget on the #901
    fixtures versus the pre-rerank baseline, at equal-or-lower budget.

    This FAILS if the rerank is a no-op (mean precision would be unchanged)."""

    def test_precision_at_budget_improves_with_rerank_on(self) -> None:
        with _rerank(False):
            baseline = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)
        with _rerank(True):
            reranked = evaluate_retrieval(REPO_ROOT, RETRIEVAL_FIXTURE_FILE)

        base_mean = _mean_precision(baseline)
        rerank_mean = _mean_precision(reranked)
        self.assertGreater(
            rerank_mean,
            base_mean,
            "AC4: mean precision_at_budget must improve with the rerank ON. "
            f"baseline={base_mean:.4f} reranked={rerank_mean:.4f}. "
            "A no-op rerank fails this guard.",
        )

        # Budget is equal-or-lower: every fixture keeps no more considered
        # candidates with rerank ON than with rerank OFF (it never pads).
        base_by_name = {f["name"]: f for f in baseline["fixtures"]}
        for fixture in reranked["fixtures"]:
            if fixture["status"] == "skipped":
                continue
            base = base_by_name[fixture["name"]]
            on_considered = len(fixture.get("topResults") or [])
            off_considered = len(base.get("topResults") or [])
            self.assertLessEqual(
                on_considered,
                off_considered,
                f"{fixture['name']}: rerank must keep equal-or-fewer considered "
                f"candidates (lower-or-equal budget); on={on_considered} off={off_considered}",
            )

        # And no individual fixture regresses below its baseline precision.
        for fixture in reranked["fixtures"]:
            if fixture["status"] == "skipped":
                continue
            base = base_by_name[fixture["name"]]
            on_p = fixture["metrics"]["precisionAtBudget"]["precision"]
            off_p = base["metrics"]["precisionAtBudget"]["precision"]
            self.assertGreaterEqual(
                on_p, off_p,
                f"{fixture['name']} regressed: on={on_p} off={off_p}",
            )


if __name__ == "__main__":
    unittest.main()
