"""Acceptance tests for issue #1043 slice 1 — deterministic query-expansion
(recall) layer behind a default-OFF flag.

What each group pins:

  * expand_query_tokens splits identifier-like runs in the RAW query on
    snake_case / camelCase / PascalCase / dotted / path boundaries and UNIONs
    the recovered subtokens into the token set, subject to precision guards
    (min length; never duplicate/drop originals) — fully deterministic.
  * query_expansion_enabled defaults OFF and is truthy only for
    {"1","true","on","yes"} (case/space-insensitive).
  * At the query_context level the layer is telemetered on the returned pack
    (pack["expansion"]) and is recall-monotone: turning the flag ON can only
    GROW the retrieved candidate set (flag-ON ids ⊇ flag-OFF ids).

The unit tests are deterministic and need no index. The integration test builds
a tiny throwaway repo + index; it is written to isolate the expansion effect by
forcing the (separate, default-ON) rerank stage OFF so top-K truncation cannot
mask the superset property. It SKIPs rather than fails if the index/query
machinery is unavailable in the environment.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from agentrail.context.expansion import expand_query_tokens, query_expansion_enabled

REPO_ROOT = Path(__file__).parent.parent.parent.parent


@contextmanager
def _expansion(enabled: bool):
    """Temporarily force the query-expansion layer on/off via its env toggle,
    restoring the previous value (or unsetting) on exit."""
    key = "AGENTRAIL_CONTEXT_QUERY_EXPANSION"
    prev = os.environ.get(key)
    os.environ[key] = "1" if enabled else "0"
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


@contextmanager
def _env(key: str, value):
    """Set/unset an env var for the duration of the block, then restore it."""
    prev = os.environ.get(key)
    if value is None:
        os.environ.pop(key, None)
    else:
        os.environ[key] = value
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


# ---------------------------------------------------------------------------
# expand_query_tokens — deterministic identifier subtoken recovery
# ---------------------------------------------------------------------------

class ExpandQueryTokens(unittest.TestCase):
    def test_snake_case_query_context_handler_adds_subtokens(self) -> None:
        """`query_context handler` recovers `query` + `context`; the whole
        `query_context` token stays; `handler` is not re-added; originals first."""
        base = ["query_context", "handler"]
        expanded, added = expand_query_tokens("query_context handler", base)
        self.assertIn("query", added)
        self.assertIn("context", added)
        self.assertNotIn("handler", added, "handler is already a base token; must not be re-added")
        self.assertNotIn("query_context", added, "the original whole token must not be re-added")
        # originals preserved, in order, at the front
        self.assertEqual(expanded[: len(base)], base)
        # every added term follows the originals
        self.assertEqual(set(expanded), set(base) | set(added))

    def test_camel_case_query_context_adds_subtokens(self) -> None:
        """camelCase `queryContext` splits into `query` + `context`."""
        base = ["querycontext"]  # what a lowercasing tokenizer would produce
        expanded, added = expand_query_tokens("queryContext", base)
        self.assertIn("query", added)
        self.assertIn("context", added)
        self.assertNotIn("querycontext", added)
        self.assertEqual(expanded[0], "querycontext")

    def test_pascal_case_and_acronym_split(self) -> None:
        """PascalCase with an acronym: `HTTPServer` -> `http` + `server`."""
        base = ["httpserver"]
        expanded, added = expand_query_tokens("HTTPServer", base)
        self.assertIn("http", added)
        self.assertIn("server", added)

    def test_min_length_guard_drops_short_fragments(self) -> None:
        """`db_io` yields only 2-char fragments (`db`, `io`); with the default
        min_added_len=3 neither is added."""
        base = ["db_io"]
        expanded, added = expand_query_tokens("db_io", base)
        self.assertEqual(added, [], f"2-char fragments must be dropped, got {added}")
        self.assertEqual(expanded, base)

    def test_min_length_guard_is_configurable(self) -> None:
        """Lowering min_added_len lets the short fragments through (proves the
        guard, not the tokenizer, is what suppressed them above)."""
        _, added = expand_query_tokens("db_io", ["db_io"], min_added_len=2)
        self.assertIn("db", added)
        self.assertIn("io", added)

    def test_originals_never_dropped_and_no_new_terms_when_all_present(self) -> None:
        """If the subtokens are already base tokens, nothing is added and every
        original is preserved (recall-monotone at the token level)."""
        base = ["handler", "query", "context"]
        expanded, added = expand_query_tokens("handler query context", base)
        self.assertEqual(added, [])
        self.assertEqual(expanded, base)

    def test_added_terms_sorted_and_deduped(self) -> None:
        """added_terms is a sorted, de-duplicated list even when a subtoken
        recurs across the query."""
        # "queryContext query_context" repeats query/context across two runs.
        _, added = expand_query_tokens("queryContext query_context", ["queryContext"])
        self.assertEqual(added, sorted(added), "added_terms must be sorted")
        self.assertEqual(len(added), len(set(added)), "added_terms must be de-duplicated")
        self.assertIn("context", added)
        self.assertIn("query", added)

    def test_expanded_tokens_deduped_preserving_first_seen_order(self) -> None:
        """expanded_tokens contains no duplicates and keeps originals ahead of
        added terms."""
        base = ["query_context", "handler"]
        expanded, _ = expand_query_tokens("query_context handler", base)
        self.assertEqual(len(expanded), len(set(expanded)), "expanded_tokens must be de-duplicated")
        self.assertLess(expanded.index("handler"), expanded.index("query"))

    def test_is_deterministic_across_repeated_calls(self) -> None:
        """Same input → byte-identical output on every call (no randomness /
        clock / network)."""
        base = ["query_context", "parseRequestBody", "db_io"]
        query = "query_context parseRequestBody db_io"
        first = expand_query_tokens(query, base)
        for _ in range(5):
            self.assertEqual(expand_query_tokens(query, base), first)


# ---------------------------------------------------------------------------
# query_expansion_enabled — default-OFF flag parsing
# ---------------------------------------------------------------------------

class QueryExpansionFlag(unittest.TestCase):
    KEY = "AGENTRAIL_CONTEXT_QUERY_EXPANSION"

    def test_unset_is_disabled(self) -> None:
        with _env(self.KEY, None):
            self.assertFalse(query_expansion_enabled())

    def test_truthy_values_enable(self) -> None:
        for value in ("1", "true", "on", "yes", "TRUE", "On", "  yes  "):
            with _env(self.KEY, value):
                self.assertTrue(
                    query_expansion_enabled(), f"{value!r} should enable expansion"
                )

    def test_falsy_and_unknown_values_disable(self) -> None:
        for value in ("0", "false", "off", "no", "", "maybe", "2"):
            with _env(self.KEY, value):
                self.assertFalse(
                    query_expansion_enabled(), f"{value!r} should NOT enable expansion"
                )


# ---------------------------------------------------------------------------
# Integration — telemetry + recall-monotone superset at the query_context level
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
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@test.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)


def _make_expansion_repo() -> Path:
    """Repo where identifier-boundary recall matters.

    The query `queryContext` collapses (lowercased) to the single base token
    `querycontext`, which no file spells. Expansion recovers `query` + `context`,
    which two *extra* files spell as whole words — so flag-ON must retrieve a
    strict superset of flag-OFF.
    """
    root = Path(tempfile.mkdtemp())
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(_base_config(), indent=2), encoding="utf-8"
    )
    (root / "src").mkdir()
    # Spells the collapsed base token -> retrieved with the flag OFF too.
    (root / "src" / "querycontext.py").write_text(
        "def querycontext():\n    return 'querycontext handler'\n",
        encoding="utf-8",
    )
    # Spell the recovered subtokens -> only reachable once expansion adds them.
    (root / "src" / "query_builder.py").write_text(
        "def query(sql):\n    # build a query\n    return sql\n",
        encoding="utf-8",
    )
    (root / "src" / "context_store.py").write_text(
        "def context():\n    # the context store\n    return {}\n",
        encoding="utf-8",
    )
    _git_init(root)
    from agentrail.context.index import build_index

    build_index(root)
    return root


class QueryContextExpansionIntegration(unittest.TestCase):
    """Telemetry is always present; flag-ON retrieves a superset of flag-OFF.

    The (separate) rerank stage is forced OFF so its top-K truncation cannot mask
    the recall-monotone property that expansion provides at the candidate stage.
    """

    @classmethod
    def setUpClass(cls) -> None:
        try:
            from agentrail.context.retrieval import query_context  # noqa: F401
        except Exception as exc:  # pragma: no cover - env-dependent
            raise unittest.SkipTest(f"query_context unavailable: {exc}")
        try:
            cls.repo = _make_expansion_repo()
        except Exception as exc:  # pragma: no cover - env-dependent
            raise unittest.SkipTest(f"could not build integration repo/index: {exc}")

    @staticmethod
    def _result_paths(pack: dict) -> set:
        return {r.get("path") for r in pack.get("results", []) if r.get("path")}

    def test_flag_off_telemetry_reports_disabled_and_no_added_terms(self) -> None:
        from agentrail.context.retrieval import query_context

        with _env("AGENTRAIL_CONTEXT_QUERY_EXPANSION", None), _rerank_off():
            pack = query_context(self.repo, "queryContext", limit=20)
        self.assertIn("expansion", pack, "pack must carry the expansion telemetry block")
        self.assertFalse(pack["expansion"]["enabled"])
        self.assertEqual(pack["expansion"]["addedTerms"], [])
        self.assertEqual(pack["expansion"]["cost"], 0.0)

    def test_flag_on_telemetry_reports_expected_added_terms(self) -> None:
        from agentrail.context.retrieval import query_context

        with _expansion(True), _rerank_off():
            pack = query_context(self.repo, "queryContext", limit=20)
        self.assertTrue(pack["expansion"]["enabled"])
        added = set(pack["expansion"]["addedTerms"])
        self.assertIn("query", added)
        self.assertIn("context", added)
        self.assertEqual(pack["expansion"]["cost"], 0.0)

    def test_flag_on_retrieves_superset_of_flag_off(self) -> None:
        from agentrail.context.retrieval import query_context

        with _env("AGENTRAIL_CONTEXT_QUERY_EXPANSION", None), _rerank_off():
            off = self._result_paths(query_context(self.repo, "queryContext", limit=20))
        with _expansion(True), _rerank_off():
            on = self._result_paths(query_context(self.repo, "queryContext", limit=20))
        self.assertTrue(
            off <= on,
            f"expansion must be recall-monotone: flag-ON results {on} must be a "
            f"superset of flag-OFF results {off}",
        )
        self.assertTrue(
            on - off,
            "expansion should recall at least one additional file for this fixture "
            f"(off={off}, on={on})",
        )


@contextmanager
def _rerank_off():
    """Force the (default-ON) rerank stage OFF so its top-K truncation does not
    interfere with the expansion recall-monotone assertion."""
    key = "AGENTRAIL_CONTEXT_RERANK"
    prev = os.environ.get(key)
    os.environ[key] = "0"
    try:
        yield
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev


if __name__ == "__main__":
    unittest.main()
