"""Tests for agentrail context ast s-expression search (M021).

Evidence-based: asserts matching node names and line numbers against known
fixture files, and asserts denied-source exclusion.
"""
from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from agentrail.cli.commands.context import run_context
from agentrail.context.ast_search import ast_query
from agentrail.context.index import build_index

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tree_sitter"


def _make_repo(*, deny_globs: list[str] | None = None) -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    exclude_globs = [".git/**", ".agentrail/context/**"]
    if deny_globs:
        exclude_globs.extend(deny_globs)
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": exclude_globs,
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2),
        encoding="utf-8",
    )
    return root


class AstQueryTests(unittest.TestCase):
    def test_python_function_found_at_expected_line(self) -> None:
        """AC1: function_definition query returns result with expected line and full schema."""
        root = _make_repo()
        (root / "sample.py").write_text(
            (FIXTURE_DIR / "sample.py").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        build_index(root)

        result = ast_query(root, "(function_definition name: (identifier) @fn)")
        results = result["results"]

        self.assertGreater(len(results), 0, "Expected at least one result")
        greet = next(
            (r for r in results if r["path"] == "sample.py" and "greet" in r["content"]),
            None,
        )
        self.assertIsNotNone(greet, "Expected to find 'greet' in results")
        self.assertEqual(greet["lineStart"], 1, "greet is defined on line 1")

        # Verify full house schema fields
        for field in ("path", "lineStart", "lineEnd", "content", "citation", "reason", "score", "tokenEstimate", "deterministic"):
            self.assertIn(field, greet, f"Missing required field: {field!r}")
        self.assertTrue(greet["reason"].startswith("AST match: "), greet["reason"])
        self.assertEqual(greet["score"], {"final": 1.0})
        self.assertIs(greet["deterministic"], True)
        self.assertEqual(greet["citation"], f"sample.py:{greet['lineStart']}-{greet['lineEnd']}")

    def test_denied_source_absent_from_results(self) -> None:
        """AC2: denied source (via excludeGlobs) never appears in ast results."""
        root = _make_repo(deny_globs=["denied.py"])
        (root / "sample.py").write_text(
            (FIXTURE_DIR / "sample.py").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        (root / "denied.py").write_text(
            "def secret_func():\n    return 42\n",
            encoding="utf-8",
        )
        build_index(root)

        result = ast_query(root, "(function_definition name: (identifier) @fn)")
        result_paths = [r["path"] for r in result["results"]]

        self.assertNotIn("denied.py", result_paths, "Denied source must not appear in results")
        # sample.py should still appear
        self.assertIn("sample.py", result_paths, "Allowed source must appear")

    def test_limit_caps_result_count(self) -> None:
        """AC3: --limit N caps the result count at N."""
        root = _make_repo()
        many_funcs = "\n\n".join(f"def func_{i}():\n    return {i}" for i in range(10))
        (root / "many_funcs.py").write_text(many_funcs, encoding="utf-8")
        build_index(root)

        result = ast_query(root, "(function_definition name: (identifier) @fn)", limit=1)
        self.assertEqual(len(result["results"]), 1)

    def test_json_output_valid_schema(self) -> None:
        """AC4: --json output is valid JSON matching house result schema."""
        root = _make_repo()
        (root / "sample.py").write_text(
            (FIXTURE_DIR / "sample.py").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        build_index(root)

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = run_context([
                "ast",
                "(function_definition name: (identifier) @fn)",
                "--target", str(root),
                "--json",
            ])
        self.assertEqual(code, 0)
        output = json.loads(buf.getvalue())
        self.assertIn("results", output)
        self.assertIn("excluded", output)
        for item in output["results"]:
            for field in ("path", "lineStart", "lineEnd", "content", "citation", "reason", "score", "tokenEstimate", "deterministic"):
                self.assertIn(field, item, f"Missing house-schema field: {field!r}")

    def test_invalid_s_expression_nonzero_exit(self) -> None:
        """AC5: invalid s-expression returns non-zero exit and error on stderr."""
        root = _make_repo()
        err_buf = io.StringIO()
        out_buf = io.StringIO()
        with redirect_stderr(err_buf), redirect_stdout(out_buf):
            code = run_context(["ast", "(bad", "--target", str(root)])
        self.assertNotEqual(code, 0, "Expected non-zero exit for invalid s-expression")
        err = err_buf.getvalue()
        self.assertTrue(err.strip(), "Expected an error message on stderr")
        # No Python traceback on stdout
        self.assertNotIn("Traceback", out_buf.getvalue())

    def test_text_output_prints_citation_and_reason(self) -> None:
        """Non-JSON output prints one line per result with citation and reason."""
        root = _make_repo()
        (root / "sample.py").write_text(
            (FIXTURE_DIR / "sample.py").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        build_index(root)

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = run_context([
                "ast",
                "(function_definition name: (identifier) @fn)",
                "--target", str(root),
            ])
        self.assertEqual(code, 0)
        out = buf.getvalue()
        self.assertIn("sample.py:", out)
        self.assertIn("AST match:", out)


if __name__ == "__main__":
    unittest.main()
