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
    build_issue_context_pack,
    context_retrieval_metadata,
    context_pack_summary,
    context_selected_snippets,
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

    def test_snippet_lines_indented(self) -> None:
        fake = {"results": self._make_results(), "runMetadata": {}}
        with patch("agentrail.run.context.search_context", return_value=fake):
            result = context_selected_snippets(Path("/tmp/repo"), "auth login")
        # snippet lines should be indented with 4 spaces
        self.assertIn("    def login(user):", result)


if __name__ == "__main__":
    unittest.main()
