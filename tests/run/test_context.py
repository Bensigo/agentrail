"""Unit tests for agentrail/run/context.py.

All external I/O (subprocess.run, build_context_pack, search_context, filesystem)
is patched so these tests run without a real repo, gh CLI, or context index.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.run.context import (
    issue_resolution_text,
    build_pack,
    build_issue_context_pack,
    context_retrieval_metadata,
    context_pack_summary,
    context_selected_snippets,
    _MAX_CONTENT_SNIPPETS,
    _MAX_SNIPPET_LINES,
    _MAX_TOTAL_CHARS,
)


class IssueResolutionTextTests(unittest.TestCase):
    def test_success_returns_stripped_stdout(self) -> None:
        proc = MagicMock(returncode=0, stdout="Title\nBody\n")
        with patch("agentrail.run.context.subprocess.run", return_value=proc):
            result = issue_resolution_text(Path("/tmp/repo"), 5)
        self.assertEqual(result, "Title\nBody")

    def test_failure_returns_fallback(self) -> None:
        proc = MagicMock(returncode=1, stdout="")
        with patch("agentrail.run.context.subprocess.run", return_value=proc):
            result = issue_resolution_text(Path("/tmp/repo"), 5)
        self.assertEqual(result, "GitHub issue #5")

    def test_empty_stdout_on_success_returns_fallback(self) -> None:
        proc = MagicMock(returncode=0, stdout="   ")
        with patch("agentrail.run.context.subprocess.run", return_value=proc):
            result = issue_resolution_text(Path("/tmp/repo"), 7)
        self.assertEqual(result, "GitHub issue #7")


class BuildIssueContextPackTests(unittest.TestCase):
    def test_returns_json_path_on_success(self) -> None:
        fake_pack = {"jsonPath": ".agentrail/context/packs/x.json"}
        with patch("agentrail.run.context.build_context_pack", return_value=fake_pack):
            result = build_issue_context_pack(Path("/tmp/repo"), 42, "plan")
        self.assertEqual(result, ".agentrail/context/packs/x.json")

    def test_returns_none_on_exception(self) -> None:
        with patch("agentrail.run.context.build_context_pack", side_effect=RuntimeError("boom")):
            result = build_issue_context_pack(Path("/tmp/repo"), 42, "plan")
        self.assertIsNone(result)

    def test_returns_none_when_json_path_missing(self) -> None:
        with patch("agentrail.run.context.build_context_pack", return_value={}):
            result = build_issue_context_pack(Path("/tmp/repo"), 42, "plan")
        self.assertIsNone(result)


class ContextRetrievalMetadataTests(unittest.TestCase):
    def test_returns_run_metadata_dict(self) -> None:
        fake = {"runMetadata": {"retrievalMode": "lexical"}, "results": []}
        with patch("agentrail.run.context.search_context", return_value=fake):
            result = context_retrieval_metadata(Path("/tmp/repo"), "some query")
        self.assertEqual(result, {"retrievalMode": "lexical"})

    def test_returns_empty_dict_on_exception(self) -> None:
        with patch("agentrail.run.context.search_context", side_effect=Exception("err")):
            result = context_retrieval_metadata(Path("/tmp/repo"), "query")
        self.assertEqual(result, {})

    def test_returns_empty_dict_when_run_metadata_missing(self) -> None:
        with patch("agentrail.run.context.search_context", return_value={"results": []}):
            result = context_retrieval_metadata(Path("/tmp/repo"), "query")
        self.assertEqual(result, {})


class ContextPackSummaryTests(unittest.TestCase):
    def _write_pack(self, target_dir: Path, pack_file: str, data: dict) -> None:
        pack_path = target_dir / pack_file
        pack_path.parent.mkdir(parents=True, exist_ok=True)
        pack_path.write_text(json.dumps(data))

    def _make_pack(self) -> dict:
        return {
            "target": {"kind": "issue", "number": 42, "phase": "plan"},
            "goal": {"summary": "Fix the login bug"},
            "requiredContext": [
                {"path": "src/auth.py", "reason": "core"},
                {"path": "src/db.py", "reason": "deps"},
                {"path": "tests/test_auth.py", "reason": "tests"},
            ],
            "likelyFiles": [{"path": "src/utils.py"}],
            "likelyDocs": [],
            "relevantMemory": [],
            "priorMistakes": [],
            "activeState": [],
            "goals": [],
            "openQuestions": [],
        }

    def test_returns_banner_for_falsy_pack_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result_empty = context_pack_summary(Path(tmp), "")
            result_none = context_pack_summary(Path(tmp), None)
        self.assertIn("Summary unavailable.", result_empty)
        self.assertIn("- Pack file: none", result_empty)
        self.assertIn("Summary unavailable.", result_none)
        self.assertIn("- Pack file: none", result_none)

    def test_returns_banner_for_nonexistent_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = context_pack_summary(Path(tmp), ".agentrail/context/packs/nope.json")
        self.assertIn("Summary unavailable.", result)
        self.assertIn("- Pack file: none", result)

    def test_summary_contains_expected_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            pack_file = ".agentrail/context/packs/issue-42-plan-abc.json"
            self._write_pack(target, pack_file, self._make_pack())
            result = context_pack_summary(target, pack_file)
        self.assertIn("Context pack:", result)
        self.assertIn(f"- Pack file: {pack_file}", result)
        self.assertIn("- Target: issue #42 plan", result)
        self.assertIn("- Goal: Fix the login bug", result)
        self.assertIn("- Required context: 3", result)
        self.assertIn("- Likely files: 1", result)
        self.assertIn("- Likely docs: 0", result)
        # advisory line
        self.assertIn("Use the selected context above", result)

    def test_first_paths_appear_in_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            pack_file = ".agentrail/context/packs/issue-42-plan-abc.json"
            self._write_pack(target, pack_file, self._make_pack())
            result = context_pack_summary(target, pack_file)
        # firstPaths shows up to 2 paths for requiredContext
        self.assertIn("src/auth.py", result)
        self.assertIn("src/db.py", result)
        # third path should NOT appear (limit=2)
        self.assertNotIn("tests/test_auth.py", result)

    def test_missing_goal_falls_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            pack_file = ".agentrail/context/packs/no-goal.json"
            data = self._make_pack()
            del data["goal"]
            self._write_pack(target, pack_file, data)
            result = context_pack_summary(target, pack_file)
        self.assertIn("No goal recorded.", result)


class ContextSelectedSnippetsTests(unittest.TestCase):
    def _make_results(self) -> list:
        return [
            {
                "path": "src/auth.py",
                "lineStart": 10,
                "lineEnd": 25,
                "symbol": "login",
                "tokenEstimate": 42,
                "reason": "handles auth flow",
                "snippet": "def login(user):\n    pass\n",
            },
            {
                "path": "src/db.py",
                "lineStart": 1,
                "lineEnd": 5,
                "symbol": None,
                "tokenEstimate": 10,
                "reason": "db init",
                "snippet": "import psycopg2\n",
            },
        ]

    def test_returns_formatted_snippets(self) -> None:
        fake = {"results": self._make_results(), "runMetadata": {}}
        with patch("agentrail.run.context.search_context", return_value=fake):
            result = context_selected_snippets(Path("/tmp/repo"), "auth login")
        self.assertIn("Selected context (compact", result)
        self.assertIn("src/auth.py:10-25", result)
        self.assertIn("src/db.py:1-5", result)
        self.assertIn("login", result)
        self.assertIn("42 tok", result)
        self.assertIn("handles auth flow", result)

    def test_empty_results_returns_fallback(self) -> None:
        fake = {"results": [], "runMetadata": {}}
        with patch("agentrail.run.context.search_context", return_value=fake):
            result = context_selected_snippets(Path("/tmp/repo"), "nothing")
        self.assertIn("none", result)

    def test_exception_returns_empty_string(self) -> None:
        with patch("agentrail.run.context.search_context", side_effect=Exception("boom")):
            result = context_selected_snippets(Path("/tmp/repo"), "query")
        self.assertEqual(result, "")

    def test_advisory_line_present(self) -> None:
        fake = {"results": self._make_results(), "runMetadata": {}}
        with patch("agentrail.run.context.search_context", return_value=fake):
            result = context_selected_snippets(Path("/tmp/repo"), "auth login")
        self.assertIn("agentrail context get", result)

    def test_snippet_lines_indented_when_file_unreadable(self) -> None:
        # When the file cannot be read, top results fall back to 4-space indented
        # snippet lines from the search result's snippet field.
        fake = {"results": self._make_results(), "runMetadata": {}}
        with patch("agentrail.run.context.search_context", return_value=fake):
            # /tmp/repo/src/auth.py does not exist → OSError → pointer fallback
            result = context_selected_snippets(Path("/tmp/repo"), "auth login")
        self.assertIn("    def login(user):", result)


class ContextSelectedSnippetsContentTests(unittest.TestCase):
    """Tests for fenced content injection in context_selected_snippets."""

    def _make_result(self, path: str, line_start: int, line_end: int, snippet: str = "") -> dict:
        return {
            "path": path,
            "lineStart": line_start,
            "lineEnd": line_end,
            "symbol": None,
            "tokenEstimate": 10,
            "reason": "test reason",
            "snippet": snippet,
        }

    def test_fenced_block_present_for_readable_file(self) -> None:
        """AC1: assembled output contains a fenced code block with real content."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "src").mkdir()
            src_file = target / "src" / "auth.py"
            src_file.write_text("def login():\n    pass\n")
            results = [self._make_result("src/auth.py", 1, 2)]
            fake = {"results": results, "runMetadata": {}}
            with patch("agentrail.run.context.search_context", return_value=fake):
                result = context_selected_snippets(target, "login")
        self.assertIn("```src/auth.py:1-2", result)
        self.assertIn("def login():", result)

    def test_at_most_max_content_snippets_fenced_blocks(self) -> None:
        """Top _MAX_CONTENT_SNIPPETS results get fenced blocks; rest get pointers."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            results = []
            for i in range(5):
                fname = f"file{i}.py"
                (target / fname).write_text(f"# file {i}\ncode = {i}\n")
                results.append(self._make_result(fname, 1, 2, snippet=f"# file {i}"))
            fake = {"results": results, "runMetadata": {}}
            with patch("agentrail.run.context.search_context", return_value=fake):
                result = context_selected_snippets(target, "code")
        # Count fenced opening lines
        fenced_count = result.count("\n```")
        # Each fenced block contributes one opening ``` and one closing ```
        # Count opening fences (lines starting with ```)
        fence_opens = [l for l in result.splitlines() if l.startswith("```") and not l == "```"]
        self.assertLessEqual(len(fence_opens), _MAX_CONTENT_SNIPPETS)

    def test_line_count_cap_respected(self) -> None:
        """Content is capped at _MAX_SNIPPET_LINES lines per snippet."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            # Write a file with more lines than the cap
            long_content = "\n".join(f"line {j}" for j in range(_MAX_SNIPPET_LINES + 20))
            (target / "big.py").write_text(long_content)
            results = [self._make_result("big.py", 1, _MAX_SNIPPET_LINES + 20)]
            fake = {"results": results, "runMetadata": {}}
            with patch("agentrail.run.context.search_context", return_value=fake):
                result = context_selected_snippets(target, "line")
        # Extract content between the fences
        lines = result.splitlines()
        in_fence = False
        fence_lines = []
        for l in lines:
            if l.startswith("```big.py:"):
                in_fence = True
                continue
            if in_fence and l == "```":
                break
            if in_fence:
                fence_lines.append(l)
        self.assertLessEqual(len(fence_lines), _MAX_SNIPPET_LINES)

    def test_char_cap_triggers_pointer_fallback(self) -> None:
        """When total chars are exhausted, subsequent top results fall back to pointer."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            # First result: huge content that fills the char cap
            big_line = "x" * 200
            big_content = "\n".join(big_line for _ in range(_MAX_SNIPPET_LINES))
            (target / "big.py").write_text(big_content)
            # Second result: small readable file
            (target / "small.py").write_text("def foo(): pass\n")
            results = [
                self._make_result("big.py", 1, _MAX_SNIPPET_LINES, snippet="# big"),
                self._make_result("small.py", 1, 1, snippet="# small fallback"),
            ]
            # Override MAX_TOTAL_CHARS with a tiny cap so first result exhausts it
            import agentrail.run.context as ctx_mod
            original = ctx_mod._MAX_TOTAL_CHARS
            ctx_mod._MAX_TOTAL_CHARS = 10  # tiny cap — big.py won't fit either
            try:
                fake = {"results": results, "runMetadata": {}}
                with patch("agentrail.run.context.search_context", return_value=fake):
                    result = context_selected_snippets(target, "foo")
            finally:
                ctx_mod._MAX_TOTAL_CHARS = original
        # Neither file should appear as fenced content (cap = 10 chars, both exceeded)
        self.assertNotIn("```big.py:", result)
        self.assertNotIn("```small.py:", result)
        # Both should still appear as pointer lines
        self.assertIn("big.py:1-", result)
        self.assertIn("small.py:1-", result)

    def test_unreadable_file_falls_back_to_pointer(self) -> None:
        """When file cannot be read (OSError), result falls back to indented snippet."""
        results = [
            {
                "path": "nonexistent/path.py",
                "lineStart": 5,
                "lineEnd": 10,
                "symbol": "foo",
                "tokenEstimate": 20,
                "reason": "some reason",
                "snippet": "def foo():\n    return 42\n",
            }
        ]
        fake = {"results": results, "runMetadata": {}}
        with patch("agentrail.run.context.search_context", return_value=fake):
            # Use /tmp/nonexistent_repo so path.py definitely doesn't exist
            result = context_selected_snippets(Path("/tmp/nonexistent_repo"), "foo")
        # Should not have fenced block
        self.assertNotIn("```nonexistent/path.py:", result)
        # Should still have the pointer line
        self.assertIn("nonexistent/path.py:5-10", result)
        # Should fall back to indented snippet
        self.assertIn("    def foo():", result)

    def test_results_beyond_limit_use_pointer_format(self) -> None:
        """Results beyond _MAX_CONTENT_SNIPPETS always get pointer format."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            results = []
            for i in range(_MAX_CONTENT_SNIPPETS + 2):
                fname = f"f{i}.py"
                (target / fname).write_text(f"code = {i}\n")
                results.append(self._make_result(fname, 1, 1, snippet=f"code = {i}"))
            fake = {"results": results, "runMetadata": {}}
            with patch("agentrail.run.context.search_context", return_value=fake):
                result = context_selected_snippets(target, "code")
        # Results _MAX_CONTENT_SNIPPETS and _MAX_CONTENT_SNIPPETS+1 should not be fenced
        beyond_path = f"f{_MAX_CONTENT_SNIPPETS}.py"
        fence_tag = f"```{beyond_path}:"
        self.assertNotIn(fence_tag, result)
        # But pointer line must be present
        self.assertIn(f"{beyond_path}:1-", result)


class BuildPackTests(unittest.TestCase):
    """Tests for build_pack() (the general context-pack builder)."""

    def test_returns_json_path_on_success(self) -> None:
        fake_pack = {"jsonPath": "p.json"}
        with patch("agentrail.run.context.build_context_pack", return_value=fake_pack):
            result = build_pack(Path("/tmp/repo"), "issue", 1, "plan")
        self.assertEqual(result, "p.json")

    def test_returns_none_on_exception(self) -> None:
        with patch(
            "agentrail.run.context.build_context_pack",
            side_effect=RuntimeError("boom"),
        ):
            result = build_pack(Path("/tmp/repo"), "issue", 1, "plan")
        self.assertIsNone(result)

    def test_returns_none_when_json_path_missing(self) -> None:
        with patch("agentrail.run.context.build_context_pack", return_value={}):
            result = build_pack(Path("/tmp/repo"), "pr", 3, "review")
        self.assertIsNone(result)

    def test_passes_kind_to_build_context_pack(self) -> None:
        fake_pack = {"jsonPath": "x.json"}
        with patch(
            "agentrail.run.context.build_context_pack", return_value=fake_pack
        ) as mock_bcp:
            build_pack(Path("/tmp/repo"), "pr", 7, "review")
        mock_bcp.assert_called_once_with(Path("/tmp/repo"), "pr", 7, "review", run_id=None)

    def test_build_issue_context_pack_delegates(self) -> None:
        """build_issue_context_pack should delegate to build_pack."""
        fake_pack = {"jsonPath": ".agentrail/context/packs/x.json"}
        with patch("agentrail.run.context.build_context_pack", return_value=fake_pack):
            result = build_issue_context_pack(Path("/tmp/repo"), 42, "plan")
        self.assertEqual(result, ".agentrail/context/packs/x.json")

    def test_build_issue_context_pack_none_on_exception(self) -> None:
        with patch(
            "agentrail.run.context.build_context_pack",
            side_effect=RuntimeError("boom"),
        ):
            result = build_issue_context_pack(Path("/tmp/repo"), 42, "plan")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
