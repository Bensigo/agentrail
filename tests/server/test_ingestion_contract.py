from __future__ import annotations

import unittest

from agentrail.server.ingestion import (
    ArtifactReferenceSubmission,
    AuditEventSubmission,
    BoundedSnippet,
    CommandEventSubmission,
    ContextPackAnchor,
    ContextPackBudget,
    ContextPackCitation,
    ContextPackDecision,
    ContextPackMetadataSubmission,
    ContextPackQualityMetrics,
    ContextEventSubmission,
    CostEventSubmission,
    FailureEventSubmission,
    GraphMetadataSubmission,
    IndexSnapshotSubmission,
    IngestionEnvelope,
    RepositorySubmission,
    ReviewGateSubmission,
    RunEventSubmission,
    SourceCustodyPolicy,
    WorkspaceSubmission,
    contract_field_catalog,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


class ServerIngestionContractTests(unittest.TestCase):
    def test_default_policy_rejects_full_source_payload_without_writing_records(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        envelope = IngestionEnvelope(
            workspace_id="workspace_123",
            repository_id="repo_123",
            payload=RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                source_hashes={"agentrail/server.py": "sha256:abc123"},
                full_source={"agentrail/server.py": "def upload_everything(): pass"},
            ),
        )

        result = ingest(
            envelope,
            policy=SourceCustodyPolicy.default(),
            product_store=product_store,
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(product_store.records, [])
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "full_source_forbidden")
        self.assertIn("full_source", result.errors[0].field)
        self.assertIn("metadata, hashes, references, or allowed bounded snippets", result.errors[0].message)

    def test_bounded_snippets_are_denied_until_policy_explicitly_allows_them(self) -> None:
        snippet = BoundedSnippet(
            path="agentrail/context/compiler.py",
            citation="agentrail/context/compiler.py:264",
            start_line=264,
            end_line=269,
            content='source_custody = {"mode": "metadata_only"}',
            content_hash="sha256:def456",
        )
        envelope = IngestionEnvelope(
            workspace_id="workspace_123",
            repository_id="repo_123",
            payload=RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                source_hashes={"agentrail/context/compiler.py": "sha256:def456"},
                bounded_snippets=[snippet],
            ),
        )

        default_product_store = InMemoryProductAuthStore()
        default_telemetry_store = InMemoryTelemetryStore()
        default_result = ingest(
            envelope,
            policy=SourceCustodyPolicy.default(),
            product_store=default_product_store,
            telemetry_store=default_telemetry_store,
        )

        self.assertFalse(default_result.accepted)
        self.assertEqual(default_product_store.records, [])
        self.assertEqual(default_telemetry_store.records, [])
        self.assertEqual(default_result.errors[0].code, "bounded_snippet_not_allowed")
        self.assertIn("allow_bounded_snippets", default_result.errors[0].message)

        allowed_product_store = InMemoryProductAuthStore()
        allowed_telemetry_store = InMemoryTelemetryStore()
        allowed_policy = SourceCustodyPolicy(
            mode="bounded_snippets",
            allow_bounded_snippets=True,
            max_snippet_chars=120,
        )

        allowed_result = ingest(
            envelope,
            policy=allowed_policy,
            product_store=allowed_product_store,
            telemetry_store=allowed_telemetry_store,
        )

        self.assertTrue(allowed_result.accepted)
        self.assertEqual(allowed_result.errors, [])
        self.assertEqual(allowed_product_store.records, [envelope])
        self.assertEqual(allowed_telemetry_store.records, [])

    def test_metadata_first_payload_types_are_structured_and_accepted_by_default(self) -> None:
        payloads = [
            WorkspaceSubmission(
                workspace_id="workspace_123",
                display_name="Bensigo",
                source_custody_mode="metadata_only",
                metadata={"plan": "enterprise"},
            ),
            RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                source_hashes={"agentrail/context/compiler.py": "sha256:def456"},
            ),
            IndexSnapshotSubmission(
                snapshot_id="snapshot_123",
                repository_id="repo_123",
                indexer_id="indexer_123",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                index_hash="sha256:index123",
                source_hashes={"agentrail/context/compiler.py": "sha256:def456"},
                freshness={"agentrail/context/compiler.py": "current"},
                ingestion_health={"status": "healthy"},
                graph_metadata_ref="object://graphs/snapshot_123.json",
            ),
            GraphMetadataSubmission(
                graph_id="graph_123",
                snapshot_id="snapshot_123",
                node_count=12,
                edge_count=18,
                deterministic=True,
                graph_ref="object://graphs/snapshot_123.json",
                metadata={"authority": "deterministic"},
            ),
            ContextPackMetadataSubmission(
                context_pack_id="pack_123",
                workspace_id="workspace_123",
                repository_id="repo_123",
                run_id="run_123",
                target_kind="issue",
                target_id="133",
                content_hash="sha256:pack789",
                source_hashes={
                    "CONTEXT.md": "sha256:context123",
                    "milestones/004-server-ingestion-spine.md": "sha256:milestone004",
                },
                anchors=[
                    ContextPackAnchor(
                        anchor_id="anchor_context",
                        path="CONTEXT.md",
                        citation="CONTEXT.md:1",
                        reason="canonical domain language",
                        start_line=1,
                        end_line=20,
                        source_hash="sha256:context123",
                    )
                ],
                citations=[
                    ContextPackCitation(
                        citation_id="citation_context",
                        path="CONTEXT.md",
                        source_hash="sha256:context123",
                        start_line=1,
                        end_line=20,
                    ),
                    ContextPackCitation(
                        citation_id="citation_milestone",
                        path="milestones/004-server-ingestion-spine.md",
                        source_hash="sha256:milestone004",
                        start_line=66,
                        end_line=66,
                    )
                ],
                inclusions=[
                    ContextPackDecision(
                        item_id="CONTEXT.md",
                        citation="CONTEXT.md:1",
                        reason="defines source custody and context-pack terms",
                    )
                ],
                exclusions=[
                    ContextPackDecision(
                        item_id="console-ui",
                        citation="milestones/004-server-ingestion-spine.md:66",
                        reason="console UI is out of scope",
                    )
                ],
                budgets=ContextPackBudget(
                    max_input_tokens=12000,
                    used_input_tokens=3400,
                    max_output_tokens=2000,
                ),
                quality_metrics=ContextPackQualityMetrics(
                    required_source_coverage=1.0,
                    citation_coverage=1.0,
                    stale_or_denied_leakage=0,
                    precision_at_budget=0.9,
                ),
                artifact_ref="object://context-packs/pack_123.json",
                metadata={"phase": "execute"},
            ),
            RunEventSubmission(
                event_id="run_event_123",
                run_id="run_123",
                event_type="phase_started",
                phase="execute",
                severity="info",
                occurred_at="2026-06-06T14:30:00Z",
                agent="codex",
                metadata={"agent": "codex"},
            ),
            CostEventSubmission(
                event_id="cost_event_123",
                run_id="run_123",
                provider="openai",
                model="gpt-5.5",
                cost_usd=1.25,
                occurred_at="2026-06-06T14:31:00Z",
                agent="codex",
                phase="execute",
                metadata={"unit": "tokens"},
            ),
            AuditEventSubmission(
                event_id="audit_event_123",
                actor_id="agent:codex",
                action="source_custody_decision",
                decision="metadata_only",
                occurred_at="2026-06-06T14:32:00Z",
                run_id="run_123",
                agent="codex",
                phase="context",
                provider_call={"provider": "openai", "model": "gpt-5.5"},
                redaction={"rule_id": "secret_literal"},
                context_decision={"decision": "included", "context_pack_id": "pack_123"},
                policy_decision={"policy": "source_custody", "decision": "metadata_only"},
                metadata={"policy": "default"},
            ),
            FailureEventSubmission(
                event_id="failure_event_123",
                run_id="run_123",
                event_type="test_failure",
                phase="verify",
                severity="error",
                occurred_at="2026-06-06T14:33:00Z",
                agent="codex",
                failure_type="unit_test",
                message="focused server test failed",
            ),
            CommandEventSubmission(
                event_id="command_event_123",
                run_id="run_123",
                command="python3 -m unittest",
                event_type="command_finished",
                phase="verify",
                severity="info",
                occurred_at="2026-06-06T14:34:00Z",
                agent="codex",
                exit_code=0,
            ),
            ContextEventSubmission(
                event_id="context_event_123",
                run_id="run_123",
                event_type="context_excluded",
                phase="plan",
                severity="warning",
                occurred_at="2026-06-06T14:35:00Z",
                agent="codex",
                context_pack_id="pack_123",
                decision="excluded",
                metadata={"reason": "policy_denied"},
            ),
        ]
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual([record.payload.submission_kind for record in product_store.records], [
            "workspace",
            "repository",
        ])
        self.assertEqual([record.payload.submission_kind for record in telemetry_store.records], [
            "index_snapshot",
            "graph_metadata",
            "context_pack_metadata",
            "run_event",
            "cost_event",
            "audit_event",
            "failure_event",
            "command_event",
            "context_event",
        ])

    def test_object_storage_artifact_references_are_accepted_for_large_artifact_kinds(self) -> None:
        payloads = [
            ArtifactReferenceSubmission(
                artifact_id="artifact_log_123",
                artifact_kind="log",
                workspace_id="workspace_123",
                repository_id="repo_123",
                run_id="run_123",
                uri="object://artifacts/run_123/session.log",
                content_hash="sha256:log123",
                size_bytes=12_000_000,
                content_type="text/plain",
                metadata={"label": "session log"},
            ),
            ArtifactReferenceSubmission(
                artifact_id="artifact_transcript_123",
                artifact_kind="transcript",
                workspace_id="workspace_123",
                repository_id="repo_123",
                run_id="run_123",
                uri="object://artifacts/run_123/transcript.json",
                content_hash="sha256:transcript123",
                size_bytes=8_000_000,
                content_type="application/json",
            ),
            ArtifactReferenceSubmission(
                artifact_id="artifact_evidence_123",
                artifact_kind="evidence_bundle",
                workspace_id="workspace_123",
                repository_id="repo_123",
                run_id="run_123",
                uri="object://artifacts/run_123/evidence.zip",
                content_hash="sha256:evidence123",
                size_bytes=20_000_000,
                content_type="application/zip",
            ),
            ArtifactReferenceSubmission(
                artifact_id="artifact_screenshot_123",
                artifact_kind="screenshot",
                workspace_id="workspace_123",
                repository_id="repo_123",
                run_id="run_123",
                uri="object://artifacts/run_123/screenshot.png",
                content_hash="sha256:screenshot123",
                size_bytes=4_000_000,
                content_type="image/png",
            ),
            ArtifactReferenceSubmission(
                artifact_id="artifact_snapshot_123",
                artifact_kind="index_snapshot",
                workspace_id="workspace_123",
                repository_id="repo_123",
                snapshot_id="snapshot_123",
                uri="object://artifacts/repo_123/snapshot_123.json",
                content_hash="sha256:snapshot123",
                size_bytes=15_000_000,
                content_type="application/json",
            ),
            ArtifactReferenceSubmission(
                artifact_id="artifact_context_pack_123",
                artifact_kind="context_pack",
                workspace_id="workspace_123",
                repository_id="repo_123",
                context_pack_id="pack_123",
                uri="object://artifacts/context-packs/pack_123.json",
                content_hash="sha256:pack123",
                size_bytes=6_000_000,
                content_type="application/json",
            ),
        ]
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=product_store,
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(product_store.records, [])
        self.assertEqual(
            [record.payload.submission_kind for record in telemetry_store.records],
            ["artifact_reference"] * len(payloads),
        )
        self.assertEqual([artifact.artifact_kind for artifact in telemetry_store.artifact_references], [
            "log",
            "transcript",
            "evidence_bundle",
            "screenshot",
            "index_snapshot",
            "context_pack",
        ])
        self.assertEqual(telemetry_store.artifact_references[0].workspace_id, "workspace_123")
        self.assertEqual(telemetry_store.artifact_references[0].repository_id, "repo_123")
        self.assertEqual(telemetry_store.artifact_references[0].run_id, "run_123")

    def test_large_inline_artifact_payloads_are_rejected_from_product_and_telemetry_metadata(self) -> None:
        large_payload = "x" * 4097
        cases = [
            (
                "product_auth",
                ReviewGateSubmission(
                    review_gate_id="gate_123",
                    run_id="run_123",
                    gate_type="verification",
                    status="failed",
                    decided_at="2026-06-06T14:50:00Z",
                    evidence_ref="object://evidence/run_123/summary.json",
                    metadata={"evidence_bundle": large_payload},
                ),
                "payload.metadata.evidence_bundle",
            ),
            (
                "telemetry",
                RunEventSubmission(
                    event_id="run_event_123",
                    run_id="run_123",
                    event_type="log_captured",
                    phase="execute",
                    severity="info",
                    occurred_at="2026-06-06T14:51:00Z",
                    agent="codex",
                    metadata={"log": large_payload},
                ),
                "payload.metadata.log",
            ),
        ]

        for label, payload, field in cases:
            with self.subTest(label):
                product_store = InMemoryProductAuthStore()
                telemetry_store = InMemoryTelemetryStore()

                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=product_store,
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(product_store.records, [])
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(result.errors[0].code, "inline_artifact_body_forbidden")
                self.assertEqual(result.errors[0].field, field)
                self.assertIn("ArtifactReferenceSubmission", result.errors[0].message)

    def test_artifact_references_require_applicable_associations_on_the_reference(self) -> None:
        cases = [
            (
                "missing_repository",
                ArtifactReferenceSubmission(
                    artifact_id="artifact_log_123",
                    artifact_kind="log",
                    workspace_id="workspace_123",
                    run_id="run_123",
                    uri="object://artifacts/run_123/session.log",
                    content_hash="sha256:log123",
                    size_bytes=12_000_000,
                ),
                [("artifact_repository_association_required", "payload.repository_id")],
            ),
            (
                "missing_run",
                ArtifactReferenceSubmission(
                    artifact_id="artifact_transcript_123",
                    artifact_kind="transcript",
                    workspace_id="workspace_123",
                    repository_id="repo_123",
                    uri="object://artifacts/run_123/transcript.json",
                    content_hash="sha256:transcript123",
                    size_bytes=8_000_000,
                ),
                [("artifact_run_association_required", "payload.run_id")],
            ),
            (
                "missing_snapshot",
                ArtifactReferenceSubmission(
                    artifact_id="artifact_snapshot_123",
                    artifact_kind="index_snapshot",
                    workspace_id="workspace_123",
                    repository_id="repo_123",
                    uri="object://artifacts/repo_123/snapshot_123.json",
                    content_hash="sha256:snapshot123",
                    size_bytes=15_000_000,
                ),
                [("artifact_snapshot_association_required", "payload.snapshot_id")],
            ),
            (
                "missing_context_pack",
                ArtifactReferenceSubmission(
                    artifact_id="artifact_context_pack_123",
                    artifact_kind="context_pack",
                    workspace_id="workspace_123",
                    repository_id="repo_123",
                    uri="object://artifacts/context-packs/pack_123.json",
                    content_hash="sha256:pack123",
                    size_bytes=6_000_000,
                ),
                [("artifact_context_pack_association_required", "payload.context_pack_id")],
            ),
            (
                "workspace_mismatch",
                ArtifactReferenceSubmission(
                    artifact_id="artifact_log_456",
                    artifact_kind="log",
                    workspace_id="workspace_other",
                    repository_id="repo_123",
                    run_id="run_123",
                    uri="object://artifacts/run_123/session.log",
                    content_hash="sha256:log456",
                    size_bytes=12_000_000,
                ),
                [("artifact_workspace_mismatch", "payload.workspace_id")],
            ),
        ]

        for label, payload, expected_errors in cases:
            with self.subTest(label):
                product_store = InMemoryProductAuthStore()
                telemetry_store = InMemoryTelemetryStore()
                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=product_store,
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(product_store.records, [])
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual(
                    [(error.code, error.field) for error in result.errors],
                    expected_errors,
                )

    def test_invalid_snippet_policy_combination_returns_actionable_errors_without_writes(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        envelope = IngestionEnvelope(
            workspace_id="workspace_123",
            repository_id="repo_123",
            payload=RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                source_hashes={"src/app.py": "sha256:abc123"},
                bounded_snippets=[
                    BoundedSnippet(
                        path="src/app.py",
                        citation="src/app.py:1",
                        start_line=1,
                        end_line=1,
                        content="01234567890",
                        content_hash="sha256:snippet123",
                    )
                ],
            ),
        )

        result = ingest(
            envelope,
            policy=SourceCustodyPolicy(
                mode="bounded_snippets",
                allow_bounded_snippets=True,
                max_snippet_chars=10,
            ),
            product_store=product_store,
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(product_store.records, [])
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "bounded_snippet_too_large")
        self.assertEqual(result.errors[0].field, "payload.bounded_snippets[0].content")
        self.assertIn("max_snippet_chars", result.errors[0].message)

    def test_allowed_snippets_must_be_cited_and_line_bounded(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        envelope = IngestionEnvelope(
            workspace_id="workspace_123",
            repository_id="repo_123",
            payload=RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                source_hashes={"src/app.py": "sha256:abc123"},
                bounded_snippets=[
                    BoundedSnippet(
                        path="src/app.py",
                        citation="",
                        start_line=10,
                        end_line=2,
                        content="print('bounded')",
                        content_hash="sha256:snippet123",
                    )
                ],
            ),
        )

        result = ingest(
            envelope,
            policy=SourceCustodyPolicy(
                mode="bounded_snippets",
                allow_bounded_snippets=True,
                max_snippet_chars=120,
            ),
            product_store=product_store,
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(product_store.records, [])
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("bounded_snippet_missing_citation", "payload.bounded_snippets[0].citation"),
                ("bounded_snippet_invalid_line_range", "payload.bounded_snippets[0].start_line"),
            ],
        )
        self.assertTrue(all(error.message for error in result.errors))

    def test_snippet_policy_requires_a_positive_size_bound(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        envelope = IngestionEnvelope(
            workspace_id="workspace_123",
            repository_id="repo_123",
            payload=RepositorySubmission(
                repository_id="repo_123",
                name="agentrail",
                default_branch="main",
                remote_url="https://github.com/Bensigo/agentrail",
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
                source_hashes={"src/app.py": "sha256:abc123"},
                bounded_snippets=[
                    BoundedSnippet(
                        path="src/app.py",
                        citation="src/app.py:1",
                        start_line=1,
                        end_line=1,
                        content="print('bounded')",
                        content_hash="sha256:snippet123",
                    )
                ],
            ),
        )

        result = ingest(
            envelope,
            policy=SourceCustodyPolicy(mode="bounded_snippets", allow_bounded_snippets=True),
            product_store=product_store,
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(product_store.records, [])
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "bounded_snippet_policy_unbounded")
        self.assertIn("max_snippet_chars", result.errors[0].message)

    def test_contract_field_catalog_documents_allowed_and_forbidden_field_categories(self) -> None:
        catalog = contract_field_catalog()

        self.assertIn("workspace.display_name", catalog["metadata"])
        self.assertIn("api_key_auth.scopes", catalog["metadata"])
        self.assertIn("repository.source_hashes", catalog["hashes"])
        self.assertIn("api_key_auth.key_hash", catalog["hashes"])
        self.assertIn("index_snapshot.index_hash", catalog["hashes"])
        self.assertIn("run.api_key_id", catalog["references"])
        self.assertIn("review_gate.evidence_ref", catalog["references"])
        self.assertIn("source_custody_policy.repository_id", catalog["references"])
        self.assertIn("billing_configuration.billing_account_ref", catalog["references"])
        self.assertIn("index_snapshot.snapshot_id", catalog["references"])
        self.assertIn("index_snapshot.repository_id", catalog["references"])
        self.assertIn("index_snapshot.indexer_id", catalog["references"])
        self.assertIn("index_snapshot.graph_metadata_ref", catalog["references"])
        self.assertIn("graph_metadata.graph_id", catalog["references"])
        self.assertIn("graph_metadata.snapshot_id", catalog["references"])
        self.assertIn("context_pack_metadata.context_pack_id", catalog["references"])
        self.assertIn("context_pack_metadata.workspace_id", catalog["references"])
        self.assertIn("context_pack_metadata.repository_id", catalog["references"])
        self.assertIn("context_pack_metadata.run_id", catalog["references"])
        self.assertIn("context_pack_metadata.anchors[].citation", catalog["references"])
        self.assertIn("context_pack_metadata.inclusions[].reason", catalog["metadata"])
        self.assertIn("context_pack_metadata.exclusions[].reason", catalog["metadata"])
        self.assertIn("context_pack_metadata.source_hashes", catalog["hashes"])
        self.assertIn("context_pack_metadata.artifact_ref", catalog["references"])
        self.assertIn("artifact_reference.artifact_kind", catalog["metadata"])
        self.assertIn("artifact_reference.content_hash", catalog["hashes"])
        self.assertIn("artifact_reference.uri", catalog["references"])
        self.assertIn("artifact_reference.repository_id", catalog["references"])
        self.assertIn("artifact_reference.run_id", catalog["references"])
        self.assertIn("artifact_reference.context_pack_id", catalog["references"])
        self.assertIn("artifact_reference.snapshot_id", catalog["references"])
        self.assertIn("run_event.agent", catalog["metadata"])
        self.assertIn("cost_event.phase", catalog["metadata"])
        self.assertIn("audit_event.provider_call", catalog["metadata"])
        self.assertIn("failure_event.failure_type", catalog["metadata"])
        self.assertIn("command_event.command", catalog["metadata"])
        self.assertIn("context_event.decision", catalog["metadata"])
        self.assertIn("failure_event.run_id", catalog["references"])
        self.assertIn("command_event.run_id", catalog["references"])
        self.assertIn("context_event.context_pack_id", catalog["references"])
        self.assertIn("repository.bounded_snippets[].content", catalog["bounded_snippets"])
        self.assertIn("context_pack_metadata.bounded_snippets[].content", catalog["bounded_snippets"])
        self.assertIn("repository.full_source", catalog["forbidden_full_source"])
        self.assertIn("context_pack_metadata.metadata.source_files", catalog["forbidden_full_source"])
        self.assertIn("large inline artifact bodies in metadata", catalog["forbidden_full_source"])
        self.assertIn("raw file contents outside bounded snippets", catalog["forbidden_full_source"])


if __name__ == "__main__":
    unittest.main()
