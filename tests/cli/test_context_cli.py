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


if __name__ == "__main__":
    unittest.main()
