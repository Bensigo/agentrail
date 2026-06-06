from __future__ import annotations

import unittest

from agentrail.server.ingestion import (
    AuditEventSubmission,
    BoundedSnippet,
    ContextPackMetadataSubmission,
    CostEventSubmission,
    GraphMetadataSubmission,
    IndexSnapshotSubmission,
    InMemoryIngestionStore,
    IngestionEnvelope,
    RepositorySubmission,
    RunEventSubmission,
    SourceCustodyPolicy,
    WorkspaceSubmission,
    contract_field_catalog,
    ingest,
)


class ServerIngestionContractTests(unittest.TestCase):
    def test_default_policy_rejects_full_source_payload_without_writing_records(self) -> None:
        store = InMemoryIngestionStore()
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

        result = ingest(envelope, policy=SourceCustodyPolicy.default(), store=store)

        self.assertFalse(result.accepted)
        self.assertEqual(store.records, [])
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

        default_store = InMemoryIngestionStore()
        default_result = ingest(envelope, policy=SourceCustodyPolicy.default(), store=default_store)

        self.assertFalse(default_result.accepted)
        self.assertEqual(default_store.records, [])
        self.assertEqual(default_result.errors[0].code, "bounded_snippet_not_allowed")
        self.assertIn("allow_bounded_snippets", default_result.errors[0].message)

        allowed_store = InMemoryIngestionStore()
        allowed_policy = SourceCustodyPolicy(
            mode="bounded_snippets",
            allow_bounded_snippets=True,
            max_snippet_chars=120,
        )

        allowed_result = ingest(envelope, policy=allowed_policy, store=allowed_store)

        self.assertTrue(allowed_result.accepted)
        self.assertEqual(allowed_result.errors, [])
        self.assertEqual(allowed_store.records, [envelope])

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
                commit_sha="c64039f4cf3e945304fe1662e56c42e0814ee174",
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
                target_kind="issue",
                target_id="133",
                content_hash="sha256:pack789",
                citations=["CONTEXT.md", "milestones/004-server-ingestion-spine.md"],
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
                metadata={"agent": "codex"},
            ),
            CostEventSubmission(
                event_id="cost_event_123",
                run_id="run_123",
                provider="openai",
                model="gpt-5.5",
                cost_usd=1.25,
                occurred_at="2026-06-06T14:31:00Z",
                metadata={"unit": "tokens"},
            ),
            AuditEventSubmission(
                event_id="audit_event_123",
                actor_id="agent:codex",
                action="source_custody_decision",
                decision="metadata_only",
                occurred_at="2026-06-06T14:32:00Z",
                metadata={"policy": "default"},
            ),
        ]
        store = InMemoryIngestionStore()

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                store=store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(len(store.records), 8)
        self.assertEqual([record.payload.submission_kind for record in store.records], [
            "workspace",
            "repository",
            "index_snapshot",
            "graph_metadata",
            "context_pack_metadata",
            "run_event",
            "cost_event",
            "audit_event",
        ])

    def test_invalid_snippet_policy_combination_returns_actionable_errors_without_writes(self) -> None:
        store = InMemoryIngestionStore()
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
            store=store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(store.records, [])
        self.assertEqual(result.errors[0].code, "bounded_snippet_too_large")
        self.assertEqual(result.errors[0].field, "payload.bounded_snippets[0].content")
        self.assertIn("max_snippet_chars", result.errors[0].message)

    def test_allowed_snippets_must_be_cited_and_line_bounded(self) -> None:
        store = InMemoryIngestionStore()
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
            store=store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(store.records, [])
        self.assertEqual(
            [(error.code, error.field) for error in result.errors],
            [
                ("bounded_snippet_missing_citation", "payload.bounded_snippets[0].citation"),
                ("bounded_snippet_invalid_line_range", "payload.bounded_snippets[0].start_line"),
            ],
        )
        self.assertTrue(all(error.message for error in result.errors))

    def test_snippet_policy_requires_a_positive_size_bound(self) -> None:
        store = InMemoryIngestionStore()
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
            store=store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(store.records, [])
        self.assertEqual(result.errors[0].code, "bounded_snippet_policy_unbounded")
        self.assertIn("max_snippet_chars", result.errors[0].message)

    def test_contract_field_catalog_documents_allowed_and_forbidden_field_categories(self) -> None:
        catalog = contract_field_catalog()

        self.assertIn("workspace.display_name", catalog["metadata"])
        self.assertIn("repository.source_hashes", catalog["hashes"])
        self.assertIn("index_snapshot.graph_metadata_ref", catalog["references"])
        self.assertIn("context_pack_metadata.artifact_ref", catalog["references"])
        self.assertIn("repository.bounded_snippets[].content", catalog["bounded_snippets"])
        self.assertIn("repository.full_source", catalog["forbidden_full_source"])
        self.assertIn("raw file contents outside bounded snippets", catalog["forbidden_full_source"])


if __name__ == "__main__":
    unittest.main()
