"""Tests for candidate-filter scoring (issue #690).

AC2: Results with candidate filtering (postings present) are byte-identical to
     full-corpus scan results (postings absent).
AC3: definition_patterns regex is evaluated on O(candidates), not O(all chunks).
AC4: Postings-absent/stale fallback path returns correct results.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from typing import Any, Dict, List

from agentrail.context.index import build_index, load_index
from agentrail.context.retrieval import query_context


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _make_fixture_repo(num_noise_files: int = 50) -> Path:
    """Git repo with one searchable file and many noise files."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"],
            "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144,
            "skipBinary": True,
            "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    (root / "src").mkdir(parents=True)
    (root / "src" / "widget.py").write_text(
        "def xyzzy_token_handler():\n    return 42\n", encoding="utf-8"
    )
    (root / "lib").mkdir()
    for i in range(num_noise_files):
        (root / "lib" / f"noise_{i:04d}.py").write_text(
            f"def func_{i}():\n    return {i}\n", encoding="utf-8"
        )
    return root


def _result_key(r: Dict[str, Any]) -> tuple:
    """Stable comparison key for a result (excludes dynamic fields like generatedAt)."""
    return (r["path"], r["citation"], r["rank"], r["reason"])


def _results_stable(results: List[Dict[str, Any]]) -> List[tuple]:
    return [_result_key(r) for r in results]


def _postings_path(root: Path) -> Path:
    return root / ".agentrail" / "context" / "index" / "postings.json"


# ---------------------------------------------------------------------------
# AC2: byte-identical results
# ---------------------------------------------------------------------------

class CandidateFilterEquivalenceTests(unittest.TestCase):
    """AC2: candidate-filtered results are identical to full-corpus scan results."""

    def _build(self, noise: int = 50):
        root = _make_fixture_repo(num_noise_files=noise)
        build_index(root)
        return root, load_index(root)

    def test_results_identical_with_and_without_postings(self) -> None:
        """With postings present (candidate filtering), results match full-scan (no postings)."""
        root, index = self._build()
        pp = _postings_path(root)
        self.assertTrue(pp.exists(), "postings.json must exist after build_index")

        # With postings: candidate filtering active
        out_filtered = query_context(root, "xyzzy_token_handler", index=index)
        res_filtered = out_filtered["results"]

        # Without postings: full-corpus scan
        backup = pp.read_bytes()
        pp.unlink()
        out_fullscan = query_context(root, "xyzzy_token_handler", index=index)
        res_fullscan = out_fullscan["results"]
        pp.write_bytes(backup)  # restore for teardown

        self.assertGreater(len(res_filtered), 0, "Must return at least one result")
        self.assertEqual(
            len(res_filtered), len(res_fullscan),
            f"Candidate filter returned {len(res_filtered)} results; "
            f"full scan returned {len(res_fullscan)}"
        )
        self.assertEqual(
            _results_stable(res_filtered),
            _results_stable(res_fullscan),
            "Candidate filtering must produce byte-identical result ordering"
        )
        for rf, rfs in zip(res_filtered, res_fullscan):
            self.assertAlmostEqual(
                rf["score"]["final"], rfs["score"]["final"], places=4,
                msg=f"Score mismatch for {rf['path']}: "
                    f"filtered={rf['score']['final']} vs fullscan={rfs['score']['final']}"
            )

    def test_multiple_queries_all_equivalent(self) -> None:
        """Multiple query types produce equivalent results with/without postings."""
        root, index = self._build(noise=30)
        pp = _postings_path(root)

        for query in ["xyzzy_token_handler", "func_001", "return 42"]:
            out_filtered = query_context(root, query, index=index)

            backup = pp.read_bytes()
            pp.unlink()
            out_fullscan = query_context(root, query, index=index)
            pp.write_bytes(backup)

            self.assertEqual(
                len(out_filtered["results"]),
                len(out_fullscan["results"]),
                f"Query {query!r}: result count differs"
            )
            self.assertEqual(
                _results_stable(out_filtered["results"]),
                _results_stable(out_fullscan["results"]),
                f"Query {query!r}: result order differs with/without postings"
            )


# ---------------------------------------------------------------------------
# AC3: regex call-count bounded by candidate count
# ---------------------------------------------------------------------------

import agentrail.context.retrieval as _retrieval_mod
import re as _real_re


class _CountingPattern:
    """Wraps a compiled re.Pattern and counts .search() calls."""

    def __init__(self, pat: Any, counter: List[int]) -> None:
        self._pat = pat
        self._counter = counter

    def search(self, string: str, *args: Any, **kwargs: Any) -> Any:
        self._counter[0] += 1
        return self._pat.search(string, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pat, name)


class _CountingRe:
    """Wraps the `re` module; re.compile() returns _CountingPattern instances."""

    def __init__(self, counter: List[int]) -> None:
        self._counter = counter

    def compile(self, pattern: Any, flags: int = 0) -> _CountingPattern:
        return _CountingPattern(_real_re.compile(pattern, flags), self._counter)

    def __getattr__(self, name: str) -> Any:
        return getattr(_real_re, name)


def _count_pattern_searches(root: Path, query: str, index: Any) -> int:
    counter: List[int] = [0]
    with unittest.mock.patch.object(_retrieval_mod, "re", _CountingRe(counter)):
        query_context(root, query, index=index)
    return counter[0]


class CandidateFilterRegexBoundTests(unittest.TestCase):
    """AC3: definition_patterns regex evaluated on O(candidates), not O(all chunks)."""

    def test_regex_call_count_bounded_by_candidates(self) -> None:
        """Definition regex is bounded by chunks CONTAINING the symbol, not corpus size.

        The regex is gated on a termCount membership check (the symbol must be in
        the chunk to define it), so it never scales with corpus size — for a token
        unique to 1 file among 50+ noise files, it runs only a handful of times.
        """
        root = _make_fixture_repo(num_noise_files=50)
        build_index(root)
        index = load_index(root)
        count_filtered = _count_pattern_searches(root, "xyzzy_token_handler", index)
        self.assertLess(
            count_filtered, 10,
            f"regex ran {count_filtered}x on a 50+ chunk corpus; must be bounded by "
            "the single symbol-bearing chunk, not the corpus size",
        )

    def test_regex_not_called_on_noise_files(self) -> None:
        """Noise files (no query token) never reach the definition regex.

        The termCount gate skips the regex for any chunk that doesn't contain the
        symbol — so neither the postings (candidate-filtered) nor the
        postings-absent path scans the 40 noise files.
        """
        root = _make_fixture_repo(num_noise_files=40)
        build_index(root)
        index = load_index(root)
        pp = _postings_path(root)

        count_with = _count_pattern_searches(root, "xyzzy_token_handler", index)
        backup = pp.read_bytes()
        pp.unlink()
        count_without = _count_pattern_searches(root, "xyzzy_token_handler", index)
        pp.write_bytes(backup)

        # Both paths gate on termCount membership, so neither touches the noise
        # files — regex calls are bounded by the single symbol-bearing chunk.
        self.assertLess(
            count_with, 10,
            f"with postings: {count_with} regex calls — noise files must be skipped",
        )
        self.assertLess(
            count_without, 10,
            f"without postings: {count_without} regex calls — termCount gate still skips noise",
        )


# ---------------------------------------------------------------------------
# AC4: postings-absent / stale fallback
# ---------------------------------------------------------------------------

class CandidateFilterFallbackTests(unittest.TestCase):
    """AC4: fallback to full scan when postings are absent or stale."""

    def test_fallback_absent_postings_returns_results(self) -> None:
        """When postings.json is absent, query still returns correct results."""
        root = _make_fixture_repo(num_noise_files=20)
        build_index(root)
        _postings_path(root).unlink()

        result = query_context(root, "xyzzy_token_handler")
        self.assertGreater(len(result["results"]), 0, "Fallback must return results")
        paths = [r["path"] for r in result["results"]]
        self.assertIn("src/widget.py", paths, "Target file must appear in fallback results")

    def test_fallback_stale_postings_returns_results(self) -> None:
        """When postings.json has a stale builtAt, query falls back to full scan."""
        root = _make_fixture_repo(num_noise_files=20)
        build_index(root)
        pp = _postings_path(root)
        postings = json.loads(pp.read_text(encoding="utf-8"))
        postings["builtAt"] = "1970-01-01T00:00:00.000Z"
        pp.write_text(json.dumps(postings), encoding="utf-8")

        result = query_context(root, "xyzzy_token_handler")
        self.assertGreater(len(result["results"]), 0, "Stale-postings fallback must return results")
        paths = [r["path"] for r in result["results"]]
        self.assertIn("src/widget.py", paths, "Target file must appear in stale-postings fallback")

    def test_fallback_and_filtered_results_equivalent(self) -> None:
        """Fallback results match candidate-filtered results (AC4 quality gate)."""
        root = _make_fixture_repo(num_noise_files=20)
        build_index(root)
        index = load_index(root)
        pp = _postings_path(root)

        out_filtered = query_context(root, "xyzzy_token_handler", index=index)
        pp.unlink()
        out_fallback = query_context(root, "xyzzy_token_handler", index=index)

        self.assertEqual(
            _results_stable(out_filtered["results"]),
            _results_stable(out_fallback["results"]),
            "Fallback must return same ordered results as candidate-filter path"
        )

    def test_fallback_malformed_postings_returns_results(self) -> None:
        """When postings.json is invalid JSON, query falls back gracefully."""
        root = _make_fixture_repo(num_noise_files=10)
        build_index(root)
        _postings_path(root).write_text("{not valid json", encoding="utf-8")

        result = query_context(root, "xyzzy_token_handler")
        self.assertGreater(len(result["results"]), 0, "Malformed-postings fallback must return results")


if __name__ == "__main__":
    unittest.main()
