from __future__ import annotations

import unittest

from agentrail.server.ingestion import (
    ApiKeyAuthSubmission,
    AuditEventSubmission,
    BillingConfigurationSubmission,
    CodebaseUnitSubmission,
    CommandEventSubmission,
    ContextEventSubmission,
    CostEventSubmission,
    FailureEventSubmission,
    IndexerSubmission,
    IngestionEnvelope,
    RepositorySubmission,
    ReviewGateSubmission,
    RunEventSubmission,
    RunSubmission,
    SourceCustodyPolicy,
    SourceCustodyPolicySubmission,
    TeamSubmission,
    WorkspaceSubmission,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


class FailingTelemetryStore(InMemoryTelemetryStore):
    def write(self, envelope: IngestionEnvelope) -> None:
        raise AssertionError(f"product/auth payload used telemetry store: {envelope.payload.submission_kind}")


class FailingProductAuthStore(InMemoryProductAuthStore):
    def write(self, envelope: IngestionEnvelope) -> None:
        raise AssertionError(f"telemetry payload used product/auth store: {envelope.payload.submission_kind}")


class ProductAuthIngestionTests(unittest.TestCase):
    def test_product_auth_and_workflow_payloads_do_not_write_to_telemetry_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = FailingTelemetryStore()
        payloads = [
            WorkspaceSubmission(
                workspace_id="workspace_123",
                display_name="Bensigo",
                source_custody_mode="metadata_only",
                metadata={"plan": "enterprise"},
            ),
            TeamSubmission(
                team_id="team_123",
                workspace_id="workspace_123",
                display_name="Platform",
                metadata={"cost_center": "platform"},
            ),
            ApiKeyAuthSubmission(
                api_key_id="api_key_123",
                workspace_id="workspace_123",
                team_id="team_123",
                key_hash="sha256:key123",
                scopes=["ingest:write", "runs:write"],
                actor_id="user_123",
                metadata={"label": "local-indexer"},
            ),
            RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                team_id="team_123",
                source_hashes={"agentrail/server/ingestion.py": "sha256:abc123"},
            ),
            CodebaseUnitSubmission(
                codebase_unit_id="unit_123",
                repository_id="repo_123",
                team_id="team_123",
                name="server ingestion",
                root_path="agentrail/server",
                kind="python_package",
                metadata={"detected_by": "manifest"},
            ),
            IndexerSubmission(
                indexer_id="indexer_123",
                repository_id="repo_123",
                team_id="team_123",
                status="healthy",
                last_seen_at="2026-06-06T14:40:00Z",
                metadata={"version": "0.1.0"},
            ),
            RunSubmission(
                run_id="run_123",
                repository_id="repo_123",
                team_id="team_123",
                codebase_unit_id="unit_123",
                indexer_id="indexer_123",
                api_key_id="api_key_123",
                agent="codex",
                status="running",
                started_at="2026-06-06T14:41:00Z",
                metadata={"issue": "134"},
            ),
            ReviewGateSubmission(
                review_gate_id="gate_123",
                run_id="run_123",
                gate_type="verification",
                status="passed",
                decided_at="2026-06-06T14:42:00Z",
                evidence_ref="object://evidence/run_123/verification.json",
                metadata={"command": "python3 -m unittest"},
            ),
            SourceCustodyPolicySubmission(
                policy_id="policy_workspace",
                workspace_id="workspace_123",
                repository_id=None,
                mode="metadata_only",
                allow_bounded_snippets=False,
                max_snippet_chars=0,
                metadata={"scope": "workspace"},
            ),
            SourceCustodyPolicySubmission(
                policy_id="policy_repo",
                workspace_id="workspace_123",
                repository_id="repo_123",
                mode="bounded_snippets",
                allow_bounded_snippets=True,
                max_snippet_chars=4000,
                metadata={"scope": "repository"},
            ),
            BillingConfigurationSubmission(
                billing_configuration_id="billing_123",
                workspace_id="workspace_123",
                plan="enterprise",
                billing_account_ref="stripe:cus_123",
                metadata={"cost_center": "platform"},
            ),
        ]

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(
            [record.payload.submission_kind for record in product_store.records],
            [
                "workspace",
                "team",
                "api_key_auth",
                "repository",
                "codebase_unit",
                "indexer",
                "run",
                "review_gate",
                "source_custody_policy",
                "source_custody_policy",
                "billing_configuration",
            ],
        )
        self.assertEqual(product_store.api_keys[0].workspace_id, "workspace_123")
        self.assertEqual(product_store.api_keys[0].key_hash, "sha256:key123")
        self.assertEqual(product_store.repositories[0].team_id, "team_123")
        self.assertEqual(product_store.codebase_units[0].repository_id, "repo_123")
        self.assertEqual(product_store.indexers[0].team_id, "team_123")
        self.assertEqual(product_store.runs[0].api_key_id, "api_key_123")
        self.assertEqual(product_store.review_gates[0].run_id, "run_123")
        self.assertEqual(
            [policy.repository_id for policy in product_store.source_custody_policies],
            [None, "repo_123"],
        )
        self.assertEqual(product_store.billing_configurations[0].workspace_id, "workspace_123")

    def test_append_only_events_do_not_write_to_product_auth_store(self) -> None:
        product_store = FailingProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        payloads = [
            RunEventSubmission(
                event_id="run_event_123",
                run_id="run_123",
                event_type="phase_started",
                phase="execute",
                severity="info",
                occurred_at="2026-06-06T14:43:00Z",
                agent="codex",
                metadata={"agent": "codex"},
            ),
            CostEventSubmission(
                event_id="cost_event_123",
                run_id="run_123",
                provider="openai",
                model="gpt-5.5",
                cost_usd=1.25,
                occurred_at="2026-06-06T14:44:00Z",
                agent="codex",
                phase="execute",
                metadata={"unit": "tokens"},
            ),
            AuditEventSubmission(
                event_id="audit_event_123",
                actor_id="agent:codex",
                action="source_custody_decision",
                decision="metadata_only",
                occurred_at="2026-06-06T14:45:00Z",
                run_id="run_123",
                agent="codex",
                phase="context",
                metadata={"policy": "default"},
            ),
            FailureEventSubmission(
                event_id="failure_event_123",
                run_id="run_123",
                event_type="test_failure",
                phase="verify",
                severity="error",
                occurred_at="2026-06-06T14:46:00Z",
                agent="codex",
                failure_type="unit_test",
            ),
            CommandEventSubmission(
                event_id="command_event_123",
                run_id="run_123",
                command="python3 -m unittest",
                event_type="command_finished",
                phase="verify",
                severity="info",
                occurred_at="2026-06-06T14:47:00Z",
                agent="codex",
                exit_code=0,
            ),
            ContextEventSubmission(
                event_id="context_event_123",
                run_id="run_123",
                event_type="context_included",
                phase="context",
                severity="info",
                occurred_at="2026-06-06T14:48:00Z",
                agent="codex",
                context_pack_id="pack_123",
                decision="included",
            ),
        ]

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(
            [record.payload.submission_kind for record in telemetry_store.records],
            ["run_event", "cost_event", "audit_event", "failure_event", "command_event", "context_event"],
        )


if __name__ == "__main__":
    unittest.main()
