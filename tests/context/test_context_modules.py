from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, explain_context_pack, show_context_pack
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
        (root / ".agentrail" / "state.json").write_text(json.dumps({
            "workflow": {
                "activeIssue": 92,
                "activePhase": "execute",
                "goals": [
                    {
                        "id": "issue-92",
                        "kind": "issue",
                        "source": "github:issue/92",
                        "status": "active",
                        "summary": "Modularize context engine",
                        "successCriteria": ["Context pack evidence is cited for issue #92."],
                        "nonGoals": ["Do not include unrelated deployment work."],
                        "activeIssue": 92,
                        "activePullRequest": 44,
                        "activeMilestone": None,
                        "createdAt": "2026-06-04T09:00:00Z",
                        "updatedAt": "2026-06-04T09:10:00Z",
                    },
                    {
                        "id": "issue-11",
                        "kind": "issue",
                        "source": "github:issue/11",
                        "status": "active",
                        "summary": "Unrelated deployment goal",
                        "successCriteria": ["Deploy issue #11."],
                        "nonGoals": [],
                        "activeIssue": 11,
                        "activePullRequest": None,
                        "activeMilestone": None,
                        "createdAt": "2026-06-04T08:00:00Z",
                        "updatedAt": "2026-06-04T08:05:00Z",
                    },
                ],
            }
        }, indent=2), encoding="utf-8")
        (root / "CONTEXT.md").write_text("# Context\n\nIssue #92 context.\n", encoding="utf-8")
        (root / "TASTE.md").write_text("# Taste\n\nDirect and concrete output for #92.\n", encoding="utf-8")
        (root / "docs" / "agents").mkdir(parents=True)
        (root / "docs" / "agents" / "issue-92.md").write_text("# Issue 92\n\nModularize context engine for #92.\n", encoding="utf-8")
        (root / "docs" / "prd").mkdir(parents=True)
        (root / "docs" / "prd" / "context-engine.md").write_text("# Context Engine\n\nContext packs for issue #92 and PR #44.\n", encoding="utf-8")
        (root / "docs" / "memory").mkdir(parents=True)
        (root / "docs" / "memory" / "lesson.md").write_text("---\nkind: lesson\nsource: issue-92\nconfidence: high\ncreated_at: 2026-06-04T09:00:00Z\nexpires_at: 2026-12-31T00:00:00Z\n---\n# Context Pack Lesson\n\nKeep pack evidence cited for issue #92.\n", encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-92-retry").mkdir(parents=True)
        (root / ".agentrail" / "runs" / "issue-92-retry" / "findings.json").write_text(json.dumps({"issue": 92, "findings": [{"message": "Prior mistake for issue #92: missing citations."}]}, indent=2), encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-92-blocked").mkdir(parents=True)
        (root / ".agentrail" / "runs" / "issue-92-blocked" / "run.json").write_text(json.dumps({"targetIssue": 92, "status": "blocked", "blockedReason": "Blocked run for issue #92: verifier evidence was missing from the PR body."}, indent=2), encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-92-blocked" / "notes.md").write_text("# Blocked Notes\n\nIssue #92 blocked because verifier evidence was missing.\n", encoding="utf-8")
        (root / ".agentrail" / "runs" / "issue-11-retry").mkdir(parents=True)
        (root / ".agentrail" / "runs" / "issue-11-retry" / "findings.json").write_text(json.dumps({"issue": 11, "findings": [{"message": "Unrelated deployment mistake for issue #11: missing Kubernetes rollout."}]}, indent=2), encoding="utf-8")
        (root / "docs" / "agents" / "review-fix-92.md").write_text("# [review-fix] PR #44: Missing AC verification\n\nLabels: review-fix, ready-for-agent\nLinked issue: #92\nState: OPEN\n\nExpected correction: map each acceptance criterion to command evidence.\n", encoding="utf-8")
        (root / "docs" / "agents" / "memory-suggestion-92.md").write_text("# [memory-suggestion] PR #44: Do not claim ACs without evidence\n\nLabels: memory-suggestion, ready-for-agent\nLinked issue: #92\nState: OPEN\n\nProposed memory: Future context-pack work must cite verification output for every acceptance criterion.\n", encoding="utf-8")
        (root / "docs" / "memory" / "failure-patterns.md").write_text("# Failure Patterns\n\n## Missing acceptance criteria evidence\n\n- kind: failure-pattern\n- source: issue-92\n- confidence: verified\n- created_at: 2026-06-04\n\nAgents sometimes claim context-pack criteria without command evidence. Prevention: include the command or fixture path that proves each criterion.\n\n## Stale deployment review\n\n- kind: failure-pattern\n- source: issue-11\n- confidence: stale\n- created_at: 2024-01-01\n\nOld deployment review notes should not outrank same-issue context-pack failures.\n", encoding="utf-8")
        (root / "skills" / "backend-api").mkdir(parents=True)
        (root / "skills" / "backend-api" / "SKILL.md").write_text("# Backend API\n\nCLI contract skill for issue #92.\n", encoding="utf-8")
        (root / "docs" / "agents" / "pr-44.md").write_text("# PR 44\n\nPR #44 at /pull/44 reviews context pack generation for issue #92.\n", encoding="utf-8")
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

    def test_context_pack_sections_are_auditable(self) -> None:
        root = self.make_repo()
        build_index(root)
        output = build_context_pack(root, "issue", 92, "execute")
        pack = json.loads((root / output["jsonPath"]).read_text(encoding="utf-8"))
        expected_sections = [
            "requiredContext",
            "likelyFiles",
            "likelyDocs",
            "relevantMemory",
            "priorMistakes",
            "activeState",
            "availableTools",
            "availableSkills",
            "excludedContext",
            "openQuestions",
        ]
        for section in expected_sections:
            self.assertIn(section, pack)
        self.assertTrue(any(item["path"] == "CONTEXT.md" for item in pack["requiredContext"]))
        self.assertTrue(any(item["path"] == "src/app.py" for item in pack["likelyFiles"]))
        self.assertTrue(any(item["path"] == "docs/agents/issue-92.md" for item in pack["likelyDocs"]))
        self.assertTrue(any(item["path"] == "docs/memory/lesson.md" for item in pack["relevantMemory"]))
        self.assertTrue(any(item["path"].endswith("findings.json") for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"].endswith("run.json") for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"].endswith("notes.md") for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == "docs/agents/review-fix-92.md" for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == "docs/agents/memory-suggestion-92.md" for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == "docs/memory/failure-patterns.md" for item in pack["priorMistakes"]))
        self.assertFalse(any("issue-11-retry" in item["path"] for item in pack["priorMistakes"]))
        self.assertTrue(any(item["path"] == ".agentrail/state.json" for item in pack["activeState"]))
        self.assertTrue(any(item["id"] == "issue-92" for item in pack["goals"]))
        self.assertFalse(any(item["id"] == "issue-11" for item in pack["goals"]))
        self.assertEqual(pack["goal"]["summary"], "Modularize context engine")
        self.assertTrue(any(item["path"] == "skills/backend-api/SKILL.md" for item in pack["availableSkills"]))
        self.assertTrue(pack["availableTools"])
        self.assertTrue(pack["excludedContext"])
        for section in expected_sections:
            for item in pack[section]:
                self.assertTrue(item.get("reason"), f"{section} item missing reason: {item}")
                self.assertTrue(item.get("citation"), f"{section} item missing citation: {item}")
        for item in pack["priorMistakes"]:
            self.assertTrue(item.get("source"), f"prior mistake missing source: {item}")
            self.assertTrue(item.get("whyItMatters"), f"prior mistake missing whyItMatters: {item}")
            self.assertTrue(item.get("preventionGuidance"), f"prior mistake missing preventionGuidance: {item}")
        self.assertEqual(pack["index"]["version"], "context-index-v1")
        self.assertEqual(pack["provider"]["mode"], "disabled")
        self.assertIn("audit", pack)
        self.assertIn("jsonPath", pack["audit"])
        markdown = (root / output["markdownPath"]).read_text(encoding="utf-8")
        self.assertIn("## Required Context", markdown)
        self.assertIn("## Excluded Context", markdown)

    def test_pr_review_pack_show_and_explain_are_callable(self) -> None:
        root = self.make_repo()
        build_index(root)
        output = build_context_pack(root, "pr", 44, "review")
        pack = json.loads((root / output["jsonPath"]).read_text(encoding="utf-8"))
        self.assertEqual(pack["target"], {"kind": "pr", "number": 44, "phase": "review"})
        self.assertTrue(any(item["path"] == "docs/agents/pr-44.md" for item in pack["likelyDocs"]))

        shown = show_context_pack(root, output["packId"])
        self.assertIn("Context Pack: pr #44 review", shown)
        explained = explain_context_pack(root, output["packId"])
        self.assertEqual(explained["packId"], output["packId"])
        self.assertGreater(explained["includedCount"], 0)
        self.assertGreaterEqual(explained["excludedCount"], 1)
        self.assertTrue(explained["sections"]["likelyDocs"])


if __name__ == "__main__":
    unittest.main()
