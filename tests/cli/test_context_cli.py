from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class ContextCliTests(unittest.TestCase):
    def test_context_help_preserves_legacy_usage_contract(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        for args in (["context"], ["context", "-h"], ["context", "--help"]):
            with self.subTest(args=args):
                result = subprocess.run([str(repo / "scripts" / "agentrail"), *args], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                self.assertEqual(result.returncode, 0)
                self.assertIn("Usage:", result.stdout)
                self.assertIn("agentrail context sources [--target DIR]", result.stdout)
                self.assertIn("agentrail context build pr NUMBER --phase review [--target DIR] [--json]", result.stdout)
                self.assertIn("agentrail context show PACK [--target DIR] [--json]", result.stdout)
                self.assertIn("agentrail context explain PACK [--target DIR] [--json]", result.stdout)
                self.assertEqual(result.stderr, "")

    def test_unknown_context_command_prints_usage_to_stderr(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "unknown"], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("Unknown context command: unknown", result.stderr)
        self.assertIn("Usage:", result.stderr)

    def test_public_agentrail_context_command_uses_python_entrypoint(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nContext command boundary.\n", encoding="utf-8")
        result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "sources", "--target", str(root)], check=True, stdout=subprocess.PIPE, text=True)
        records = json.loads(result.stdout)
        self.assertTrue(any(record["path"] == "docs/agents/issue-92.md" for record in records))

    def test_context_build_show_and_explain_cli(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nContext pack generation for issue #92.\n", encoding="utf-8")
        (root / "docs" / "agents" / "pr-44.md").write_text("# PR 44\n\nPR #44 at /pull/44 reviews context packs.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "pack.py").write_text("def issue_92_pack():\n    return 'issue #92'\n", encoding="utf-8")

        issue_result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "build", "issue", "92", "--phase", "execute", "--target", str(root), "--json"], check=True, stdout=subprocess.PIPE, text=True)
        issue_output = json.loads(issue_result.stdout)
        self.assertTrue((root / issue_output["jsonPath"]).exists())
        self.assertTrue((root / issue_output["markdownPath"]).exists())

        pr_result = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "build", "pr", "44", "--phase", "review", "--target", str(root), "--json"], check=True, stdout=subprocess.PIPE, text=True)
        pr_output = json.loads(pr_result.stdout)
        self.assertTrue((root / pr_output["jsonPath"]).exists())

        shown = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "show", pr_output["packId"], "--target", str(root)], check=True, stdout=subprocess.PIPE, text=True)
        self.assertIn("Context Pack: pr #44 review", shown.stdout)
        explained = subprocess.run([str(repo / "scripts" / "agentrail"), "context", "explain", pr_output["packId"], "--target", str(root), "--json"], check=True, stdout=subprocess.PIPE, text=True)
        explanation = json.loads(explained.stdout)
        self.assertEqual(explanation["packId"], pr_output["packId"])
        self.assertIn("likelyDocs", explanation["sections"])

    def test_provider_facing_json_shape_for_context_commands(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        subprocess.run([str(repo / "scripts" / "agentrail"), "install", "--target", str(root)], check=True, stdout=subprocess.DEVNULL)
        (root / "CONTEXT.md").write_text("# Context\n\nKeep integrations explicit and observable for issue #83.\n", encoding="utf-8")
        (root / "TASTE.md").write_text("# Taste\n\nCommon actions should be obvious without instructional text.\n", encoding="utf-8")
        (root / "docs" / "agents" / "issue-83.md").write_text("# Issue 83\n\nProvider interface for context query, build, show, and explain.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "provider.py").write_text("def context_provider_surface():\n    return 'issue #83 provider interface'\n", encoding="utf-8")

        query_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "query", "issue #83 provider interface", "--target", str(root), "--json", "--limit", "3"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        query = json.loads(query_result.stdout)
        self.assertEqual(query["command"], "context.query")
        self.assertEqual(query["schemaVersion"], 1)
        self.assertEqual(query["limit"], 3)
        self.assertEqual(query["target"], {"kind": "query", "query": "issue #83 provider interface"})
        self.assertIn("provider", query)
        self.assertIn("audit", query)
        self.assertTrue(query["results"])
        for item in query["results"]:
            self.assertIn("path", item)
            self.assertIn("citation", item)
            self.assertIn("reason", item)
            self.assertIn("score", item)

        build_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "build", "issue", "83", "--phase", "execute", "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        built = json.loads(build_result.stdout)
        self.assertEqual(built["command"], "context.build")
        self.assertEqual(built["target"], {"kind": "issue", "number": 83, "phase": "execute"})
        self.assertIn("provider", built)
        self.assertIn("audit", built)
        self.assertTrue((root / built["jsonPath"]).exists())

        show_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "show", built["packId"], "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        shown = json.loads(show_result.stdout)
        self.assertEqual(shown["command"], "context.show")
        self.assertEqual(shown["packId"], built["packId"])
        self.assertEqual(shown["target"], {"kind": "issue", "number": 83, "phase": "execute"})
        self.assertIn("included", shown)
        self.assertTrue(all(item.get("citation") and item.get("reason") for item in shown["included"]))

        explain_result = subprocess.run(
            [str(repo / "scripts" / "agentrail"), "context", "explain", built["packId"], "--target", str(root), "--json"],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        )
        explained = json.loads(explain_result.stdout)
        self.assertEqual(explained["command"], "context.explain")
        self.assertEqual(explained["packId"], built["packId"])
        self.assertEqual(explained["target"], {"kind": "issue", "number": 83, "phase": "execute"})
        self.assertIn("sections", explained)
        for section in ("requiredContext", "likelyFiles", "likelyDocs", "excludedContext"):
            self.assertIn(section, explained["sections"])


if __name__ == "__main__":
    unittest.main()
