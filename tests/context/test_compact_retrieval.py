from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.retrieval import (
    RETRIEVAL_MAX_TOKENS,
    compute_tokens_saved,
    estimate_tokens,
    get_file_lines,
    get_file_symbol,
    search_context,
)


class GetFileLinesTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        (root / "src").mkdir(parents=True)
        (root / "src" / "foo.py").write_text(
            "\n".join(f"line {n}" for n in range(1, 11)) + "\n",
            encoding="utf-8",
        )
        return root

    def test_returns_only_requested_line_range(self) -> None:
        root = self.make_repo()
        result = get_file_lines(root, "src/foo.py", 2, 4)
        self.assertEqual(result["path"], "src/foo.py")
        self.assertEqual(result["lineStart"], 2)
        self.assertEqual(result["lineEnd"], 4)
        self.assertEqual(result["content"], "line 2\nline 3\nline 4")
        self.assertNotIn("line 1", result["content"])
        self.assertNotIn("line 5", result["content"])
        self.assertGreater(result["tokenEstimate"], 0)


class GetFileSymbolTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        (root / "src").mkdir(parents=True)
        (root / "src" / "mod.py").write_text(
            "def alpha():\n    return 1\n\ndef beta():\n    return 2\n",
            encoding="utf-8",
        )
        return root

    def test_returns_only_named_symbol_range(self) -> None:
        root = self.make_repo()
        result = get_file_symbol(root, "src/mod.py", "alpha")
        self.assertEqual(result["path"], "src/mod.py")
        self.assertEqual(result["symbol"], "alpha")
        self.assertEqual(result["lineStart"], 1)
        self.assertEqual(result["lineEnd"], 3)
        self.assertIn("def alpha", result["content"])
        self.assertNotIn("def beta", result["content"])

    def test_unknown_symbol_raises(self) -> None:
        root = self.make_repo()
        with self.assertRaises(SystemExit):
            get_file_symbol(root, "src/mod.py", "missing")


class ContextGetCliTests(unittest.TestCase):
    def test_cli_get_returns_only_requested_lines(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        (root / "src").mkdir(parents=True)
        (root / "src" / "foo.py").write_text(
            "\n".join(f"line {n}" for n in range(1, 11)) + "\n", encoding="utf-8")
        result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "get", "src/foo.py",
             "--lines", "2-4", "--target", str(root), "--json"],
            check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["lineStart"], 2)
        self.assertEqual(payload["lineEnd"], 4)
        self.assertEqual(payload["content"], "line 2\nline 3\nline 4")


class SearchContextTests(unittest.TestCase):
    def make_repo(self) -> Path:
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
        body = "\n".join(f"    filler_{n} = {n}" for n in range(40))
        (root / "src" / "retrieval_helper.py").write_text(
            f"def build_context_pack():\n{body}\n    return True\n",
            encoding="utf-8",
        )
        return root

    def test_returns_compact_ranked_candidates_with_line_ranges(self) -> None:
        root = self.make_repo()
        output = search_context(root, "build_context_pack", limit=5)
        self.assertEqual(output["command"], "context.search")
        self.assertTrue(output["results"], "expected at least one search result")
        top = output["results"][0]
        self.assertEqual(top["path"], "src/retrieval_helper.py")
        for key in ("path", "lineStart", "lineEnd", "snippet", "reason", "score", "tokenEstimate"):
            self.assertIn(key, top)
        self.assertIsInstance(top["lineStart"], int)
        self.assertIsInstance(top["lineEnd"], int)
        self.assertGreater(top["tokenEstimate"], 0)

    def test_search_includes_run_metadata_for_enforcement(self) -> None:
        root = self.make_repo()
        output = search_context(root, "build_context_pack", limit=5)
        rm = output["runMetadata"]
        for key in ("retrievalMode", "selectedSources", "selectedContextTokens",
                    "wastedContextTokens", "retrievalBudget", "citations", "reasons", "scores",
                    "staleOrDeniedLeakage", "staleEmbeddingLeakage"):
            self.assertIn(key, rm)
        self.assertEqual(rm["selectedContextTokens"], sum(r["tokenEstimate"] for r in output["results"]))
        self.assertEqual(rm["selectedSources"], [r["path"] for r in output["results"]])

    def test_run_metadata_budget_and_tokens_saved_are_real_numbers(self) -> None:
        # Run-level retrieval must record the real token budget (never 0/None,
        # which used to surface as token_budget=0 in pushed telemetry) and the
        # estimated tokens saved by bounded snippets vs full files.
        root = self.make_repo()
        output = search_context(root, "build_context_pack", limit=5)
        rm = output["runMetadata"]
        self.assertEqual(rm["retrievalBudget"]["maxTokens"], RETRIEVAL_MAX_TOKENS)
        self.assertEqual(rm["retrievalBudget"]["maxItems"], 5)
        self.assertIn("tokensSaved", rm)
        full_file_tokens = estimate_tokens(
            (root / "src" / "retrieval_helper.py").read_text(encoding="utf-8")
        )
        snippet_tokens = sum(
            r["tokenEstimate"] for r in output["results"]
            if r["path"] == "src/retrieval_helper.py"
        )
        self.assertEqual(rm["tokensSaved"], max(0, full_file_tokens - snippet_tokens))
        self.assertGreater(rm["tokensSaved"], 0)

    def test_snippet_is_bounded_not_whole_file(self) -> None:
        root = self.make_repo()
        output = search_context(root, "build_context_pack", limit=5)
        top = output["results"][0]
        # The source file has 40+ lines; a compact snippet must not echo all of them.
        self.assertLessEqual(len(top["snippet"].splitlines()), 12)
        self.assertNotIn("content", top, "compact search must not emit full-file content")


class SnippetWindowingTests(unittest.TestCase):
    """Acceptance test for issue #903: relevance-aware snippet windowing.

    The bounded-snippet extraction must anchor on the matched span plus the
    enclosing symbol's signature, not always the first N lines of the chunk.
    A match deep in a long function body (past the 10-line default window)
    must appear in the returned snippet alongside the function signature.

    AC1: snippet contains both the matched span AND the enclosing symbol signature.
    AC2: citation lineStart reflects the actual function start, not line 1.
    AC3: snippet remains within the line/char budget (no unbounded growth).
    """

    def make_repo(self) -> Path:
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
        return root

    def test_snippet_anchors_on_matched_span_and_enclosing_signature(self) -> None:
        """AC1 + AC2 + AC3 for issue #903.

        Fixture: a Python file with a 25-line preamble followed by a function
        whose body has 30+ filler lines before a distinctive keyword.  The
        keyword is placed well past the 10-line default window from the function
        signature, so it cannot appear in a head-biased snippet.

        Expected (after fix):
        - top result snippet contains both the function signature AND the
          distinctive keyword (AC1).
        - top result lineStart >= function definition line, not 1 (AC2).
        - snippet is bounded: ≤ 15 lines (AC3, generous to allow sig + context).
        """
        root = self.make_repo()

        # 25-line preamble — imports and module constants (lines 1-25).
        preamble = "\n".join(
            ["import os", "import sys", "import json", "from pathlib import Path"]
            + [f"_MODULE_CONST_{n} = {n}" for n in range(21)]
        )

        # Function starts at line 26.  30 filler assignments push the
        # distinctive keyword to ~line 59 (33 lines into the function body),
        # well past the 10-line snippet window.
        filler = "\n".join(f"    _step_{n} = _compute_{n}()" for n in range(1, 31))
        MATCHED_TERM = "unique_quorum_violation_xk9 = _audit_quorum_fence(items)"
        after = "\n".join(f"    _post_{n} = True" for n in range(1, 6))

        function_text = (
            "def compute_quorum_audit(items, threshold):\n"
            '    """Compute the audit quorum and validate fence conditions."""\n'
            + filler + "\n"
            "    " + MATCHED_TERM + "\n"
            + after + "\n"
            "    return True\n"
        )
        content = preamble + "\n" + function_text
        (root / "src" / "quorum_audit.py").write_text(content, encoding="utf-8")

        # Structural preconditions: confirm the fixture is set up correctly.
        file_lines = content.splitlines()
        func_line = next(
            i + 1 for i, ln in enumerate(file_lines) if "def compute_quorum_audit" in ln
        )
        match_line = next(
            i + 1 for i, ln in enumerate(file_lines) if MATCHED_TERM[:30] in ln
        )
        self.assertGreater(func_line, 1, "fixture: function must not be at file head")
        self.assertGreater(
            match_line - func_line, 10,
            "fixture: matched term must be >10 lines past the function signature "
            "so a head-biased snippet cannot contain it",
        )

        out = search_context(root, "unique_quorum_violation_xk9 audit_quorum_fence", limit=5)
        results = out["results"]
        self.assertTrue(results, "search must return at least one result")

        # The top-ranked result must be the quorum_audit file.
        top = results[0]
        self.assertEqual(top["path"], "src/quorum_audit.py")

        # AC1: snippet must include both the enclosing function signature and
        # the matched term (currently fails — head-biased window misses the match).
        self.assertIn(
            "def compute_quorum_audit",
            top["snippet"],
            "AC1: snippet must contain the enclosing symbol signature",
        )
        self.assertIn(
            "unique_quorum_violation_xk9",
            top["snippet"],
            "AC1: snippet must contain the matched span (deep in the function body); "
            "head-biased extraction returns only the first 10 lines and misses it",
        )

        # AC2: citation lineStart must reflect the function start, not the file head.
        self.assertGreaterEqual(
            top["lineStart"],
            func_line,
            "AC2: lineStart must be at or after the enclosing function definition line",
        )
        self.assertGreater(
            top["lineStart"],
            1,
            "AC2: lineStart must not be 1 (file head / preamble)",
        )

        # AC3: snippet must remain bounded — no unbounded growth.
        snippet_lines = top["snippet"].splitlines()
        self.assertLessEqual(
            len(snippet_lines),
            15,
            "AC3: snippet must respect the line cap (≤15 lines including signature + context)",
        )
        self.assertLessEqual(
            len(top["snippet"]),
            900,
            "AC3: snippet must respect the char cap",
        )


class ComputeTokensSavedTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        (root / "src").mkdir(parents=True)
        return root

    def test_full_file_minus_snippet_tokens(self) -> None:
        root = self.make_repo()
        (root / "src" / "a.py").write_text("x" * 400, encoding="utf-8")  # 100 tokens
        items = [{"path": "src/a.py", "content": "x" * 80}]  # 20 tokens used
        self.assertEqual(compute_tokens_saved(root, items), 80)

    def test_distinct_file_counted_once_with_snippets_summed(self) -> None:
        root = self.make_repo()
        (root / "src" / "a.py").write_text("x" * 400, encoding="utf-8")  # 100 tokens
        items = [
            {"path": "src/a.py", "content": "x" * 40},  # 10 tokens
            {"path": "src/a.py", "content": "x" * 40},  # 10 tokens
        ]
        # 100 - (10 + 10), not (100 - 10) * 2
        self.assertEqual(compute_tokens_saved(root, items), 80)

    def test_clamped_at_zero_when_snippets_exceed_file(self) -> None:
        root = self.make_repo()
        (root / "src" / "a.py").write_text("x" * 40, encoding="utf-8")  # 10 tokens
        items = [{"path": "src/a.py", "content": "x" * 400}]  # 100 tokens used
        self.assertEqual(compute_tokens_saved(root, items), 0)

    def test_unreadable_or_virtual_paths_contribute_nothing(self) -> None:
        root = self.make_repo()
        (root / "src" / "a.py").write_text("x" * 400, encoding="utf-8")
        items = [
            {"path": "src/a.py", "content": "x" * 80},
            {"path": "memory/not-a-file.md", "content": "x" * 80},
            {"path": "../escape.py", "content": "x" * 80},
            {"path": "", "content": "x"},
            {"content": "no path"},
            "not-a-dict",
        ]
        self.assertEqual(compute_tokens_saved(root, items), 80)

    def test_falls_back_to_token_estimate_when_no_content(self) -> None:
        root = self.make_repo()
        (root / "src" / "a.py").write_text("x" * 400, encoding="utf-8")  # 100 tokens
        items = [{"path": "src/a.py", "tokenEstimate": 30}]
        self.assertEqual(compute_tokens_saved(root, items), 70)

    def test_empty_items_is_zero(self) -> None:
        root = self.make_repo()
        self.assertEqual(compute_tokens_saved(root, []), 0)


if __name__ == "__main__":
    unittest.main()
