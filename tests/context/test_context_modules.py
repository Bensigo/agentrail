from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack
from agentrail.context.redaction import redact_text
from agentrail.context.retrieval import query_context
from agentrail.context.sources import inventory_sources


class ContextModuleTests(unittest.TestCase):
    def make_repo(self) -> Path:
        root = Path(tempfile.mkdtemp())
        subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
        (root / ".agentrail").mkdir()
        (root / ".agentrail" / "config.json").write_text(json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [".git/**", ".agentrail/context/**", ".agentrail/source/**", ".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*"],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {"enabled": True, "action": "exclude", "denyGlobs": [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*"]},
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2), encoding="utf-8")
        (root / ".agentrail" / "state.json").write_text(json.dumps({"workflow": {"activeIssue": 92}}, indent=2), encoding="utf-8")
        (root / "CONTEXT.md").write_text("# Context\n\nIssue #92 context.\n", encoding="utf-8")
        (root / "docs" / "agents").mkdir(parents=True)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nModularize context engine for #92.\n", encoding="utf-8")
        (root / "src").mkdir()
        (root / "src" / "app.py").write_text("def agentrail_context_subject():\n    return 'issue #92'\n", encoding="utf-8")
        (root / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
        return root

    def test_redaction_replaces_secret_values(self) -> None:
        result = redact_text('const apiKey = "sk-test-1234567890abcdef"; password: cleartext')
        self.assertIn("[REDACTED:secret_assignment]", result.text)
        self.assertIn("[REDACTED:password]", result.text)
        self.assertGreaterEqual(len(result.findings), 2)

    def test_source_inventory_is_callable_without_cli(self) -> None:
        root = self.make_repo()
        records = inventory_sources(root)
        paths = [record.path for record in records]
        self.assertIn("CONTEXT.md", paths)
        self.assertIn("docs/agents/issue-92.md", paths)
        self.assertNotIn(".env", paths)

    def test_index_query_and_pack_are_callable_without_shelling_out(self) -> None:
        root = self.make_repo()
        summary = build_index(root)
        self.assertGreater(summary["indexed"], 0)
        query = query_context(root, "issue #92 context engine", limit=5)
        self.assertTrue(any(item["path"] == "docs/agents/issue-92.md" for item in query["results"]))
        pack = build_context_pack(root, "issue", 92, "execute")
        self.assertTrue((root / pack["jsonPath"]).exists())
        self.assertTrue((root / pack["markdownPath"]).exists())


if __name__ == "__main__":
    unittest.main()
