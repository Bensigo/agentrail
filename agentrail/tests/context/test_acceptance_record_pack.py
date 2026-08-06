"""Acceptance Record context packs must remain bounded and auditable."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.acceptance_manifest import acceptance_context_manifest
from agentrail.context.packs import build_context_pack, load_context_pack


def make_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "context": {
                    "includeGlobs": ["**/*"],
                    "excludeGlobs": [".git/**", ".agentrail/context/**", ".env", ".env.*"],
                    "maxFileSizeBytes": 262144,
                    "skipBinary": True,
                    "respectGitIgnore": True,
                    "secretRedaction": {"enabled": True, "action": "exclude", "denyGlobs": [".env", ".env.*"]},
                    "embedding": {"mode": "disabled", "provider": None, "model": None},
                    "summary": {"mode": "disabled", "provider": None, "model": None},
                },
            }
        ),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text("# Context\n\nTrust evidence must bind to the request.\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "checkout.py").write_text(
        "def checkout_status():\n    return 'visible'\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


class AcceptanceRecordPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = make_repo()
        cls.contract = {
            "goal": "Show checkout status on the order page.",
            "acceptanceCriteria": [{"id": "AC-1", "text": "The status is visible to a signed-in buyer."}],
            "nonGoals": ["Do not alter checkout payment flow."],
            "openQuestions": [{"id": "Q-1", "text": "Which pending state copy is approved?"}],
        }

    def test_builds_a_cited_redacted_acceptance_record_pack(self) -> None:
        result = build_context_pack(
            self.root,
            "acceptance_record",
            "record-123",
            "execute",
            acceptance_contract=self.contract,
            run_id="acceptance-run-1",
        )

        self.assertEqual(
            result["target"],
            {"kind": "acceptance_record", "id": "record-123", "phase": "execute"},
        )
        self.assertTrue(result["contentHash"].startswith("sha256:"))
        self.assertEqual(result["compilerVersion"], "context-compiler-v1")
        self.assertIn("freshness", result)
        self.assertIn("custody", result)
        self.assertIn("indexProvenance", load_context_pack(self.root, result["packId"]))
        self.assertTrue((self.root / result["jsonPath"]).exists())
        self.assertTrue((self.root / result["markdownPath"]).exists())

        saved = load_context_pack(self.root, result["packId"])
        self.assertEqual(saved["contentHash"], result["contentHash"])
        self.assertEqual(saved["acceptanceContract"]["citation"], "acceptance-record:record-123#contract")
        self.assertEqual(saved["compiler"]["input"]["targetAcceptanceRecord"], "record-123")
        self.assertNotEqual(saved["compiler"]["graphExpansion"]["status"], "not_available")
        self.assertIn("commitSha", saved["indexProvenance"])
        self.assertIn("sourceTreeFingerprint", saved["indexProvenance"])
        self.assertIn("retrievalGaps", saved)
        self.assertTrue(
            any(item["citation"].endswith("#open-questions") for item in saved["openQuestions"])
        )

    def test_rejects_unconfirmed_or_missing_contract_input(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "confirmed contract"):
            build_context_pack(self.root, "acceptance_record", "record-123", "execute")

    def test_rejects_a_contract_that_would_bypass_the_context_token_budget(self) -> None:
        oversized = {"goal": "x" * 30000}
        with self.assertRaisesRegex(RuntimeError, "bounded context allowance"):
            build_context_pack(
                self.root,
                "acceptance_record",
                "record-large",
                "execute",
                acceptance_contract=oversized,
            )

    def test_content_hash_is_stable_for_same_contract_and_retrieval_inputs(self) -> None:
        first = build_context_pack(
            self.root,
            "acceptance_record",
            "record-stable",
            "execute",
            acceptance_contract=self.contract,
            run_id="acceptance-stable",
        )
        second = build_context_pack(
            self.root,
            "acceptance_record",
            "record-stable",
            "execute",
            acceptance_contract=self.contract,
            run_id="acceptance-stable",
        )
        self.assertEqual(first["contentHash"], second["contentHash"])

    def test_reduces_the_local_pack_to_bounded_metadata_without_source_content(self) -> None:
        result = build_context_pack(
            self.root,
            "acceptance_record",
            "record-manifest",
            "execute",
            acceptance_contract=self.contract,
            run_id="acceptance-manifest",
        )
        durable = acceptance_context_manifest(
            load_context_pack(self.root, result["packId"]), self.contract, repository_ref="main"
        )

        manifest = durable["manifest"]
        self.assertEqual(manifest["tokenBudget"], 6000)
        self.assertLessEqual(manifest["tokenCount"], manifest["tokenBudget"])
        self.assertEqual(manifest["acceptanceCriteria"], [{"id": "AC-1"}])
        self.assertTrue(manifest["sources"])
        self.assertTrue(all("content" not in item for item in manifest["sources"]))
        self.assertTrue(all(item["reason"] for item in manifest["sources"]))
        self.assertFalse(durable["custody"]["fullSourceUploadAllowed"])
        self.assertTrue(durable["freshness"]["indexRevision"])
        self.assertEqual(durable["freshness"]["repositoryRef"], "main")

    def test_rejects_a_selected_source_without_a_reason(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "selected source has no reason"):
            acceptance_context_manifest(
                {
                    "retrievalBudget": {"maxTokens": 100, "maxItems": 1},
                    "included": [{"path": "src/save.py", "citation": "src/save.py:1-2", "startLine": 1, "endLine": 2}],
                    "freshness": {"commitSha": "sha-1"},
                    "generatedAt": "2026-08-06T00:00:00Z",
                    "custody": {"fullSourceUploadAllowed": False},
                },
                self.contract,
                repository_ref="main",
            )
