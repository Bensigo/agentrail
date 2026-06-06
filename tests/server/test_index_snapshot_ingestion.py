from __future__ import annotations

import unittest
from typing import Mapping, Optional

from agentrail.server.ingestion import (
    GraphMetadataSubmission,
    IndexSnapshotSubmission,
    IngestionEnvelope,
    SourceCustodyPolicy,
    ingest,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.telemetry import InMemoryTelemetryStore


COMMIT_SHA = "c64039f4cf3e945304fe1662e56c42e0814ee174"


class FailingProductAuthStore(InMemoryProductAuthStore):
    def write(self, envelope: IngestionEnvelope) -> None:
        raise AssertionError(f"snapshot payload used product/auth store: {envelope.payload.submission_kind}")


class IndexSnapshotIngestionTests(unittest.TestCase):
    def test_accepts_index_snapshot_and_deterministic_graph_metadata_without_source_upload(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payloads = [
            _snapshot_submission(),
            _graph_metadata_submission(),
        ]

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=FailingProductAuthStore(),
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(len(telemetry_store.records), 2)
        self.assertEqual(len(telemetry_store.index_snapshots), 1)
        self.assertEqual(len(telemetry_store.graph_metadata), 1)
        self.assertEqual(telemetry_store.index_snapshots[0].indexer_id, "indexer_123")
        self.assertEqual(telemetry_store.index_snapshots[0].index_hash, "sha256:index123")
        self.assertTrue(telemetry_store.graph_metadata[0].deterministic)
        self.assertEqual(telemetry_store.graph_metadata[0].metadata["authority"], "deterministic")

    def test_repeated_submission_of_same_snapshot_and_graph_metadata_is_idempotent(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        payloads = [
            _snapshot_submission(),
            _snapshot_submission(),
            _graph_metadata_submission(),
            _graph_metadata_submission(),
        ]

        for payload in payloads:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=FailingProductAuthStore(),
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual([record.payload.submission_kind for record in telemetry_store.records], [
            "index_snapshot",
            "graph_metadata",
        ])
        self.assertEqual(len(telemetry_store.index_snapshots), 1)
        self.assertEqual(len(telemetry_store.graph_metadata), 1)

    def test_changed_snapshot_metadata_appends_new_evidence_without_mutating_prior_record(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        first_snapshot = _snapshot_submission(ingestion_health={"status": "healthy", "indexed_at": "2026-06-06T10:00:00Z"})
        changed_snapshot = _snapshot_submission(ingestion_health={"status": "stale", "indexed_at": "2026-06-06T10:05:00Z"})

        for payload in [first_snapshot, changed_snapshot, changed_snapshot]:
            result = ingest(
                IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                policy=SourceCustodyPolicy.default(),
                product_store=FailingProductAuthStore(),
                telemetry_store=telemetry_store,
            )
            self.assertTrue(result.accepted, f"{payload} should be accepted: {result.errors}")

        self.assertEqual(len(telemetry_store.index_snapshots), 2)
        self.assertEqual([snapshot.ingestion_health["status"] for snapshot in telemetry_store.index_snapshots], ["healthy", "stale"])
        self.assertEqual(telemetry_store.index_snapshots[0].ingestion_health["indexed_at"], "2026-06-06T10:00:00Z")
        self.assertEqual(telemetry_store.index_snapshots[1].ingestion_health["indexed_at"], "2026-06-06T10:05:00Z")

    def test_snapshot_ingestion_rejects_full_source_and_unauthorized_snippet_metadata(self) -> None:
        cases = [
            (
                "full_source",
                _snapshot_submission(ingestion_health={"status": "healthy", "full_source": {"src/app.py": "print('secret')"}}),
                ("full_source_forbidden", "payload.ingestion_health.full_source"),
            ),
            (
                "source_snippets",
                _graph_metadata_submission(metadata={"source_snippets": [{"path": "src/app.py", "content": "print('secret')"}]}),
                ("bounded_snippet_not_allowed", "payload.metadata.source_snippets"),
            ),
        ]

        for label, payload, expected_error in cases:
            with self.subTest(label):
                telemetry_store = InMemoryTelemetryStore()
                result = ingest(
                    IngestionEnvelope(workspace_id="workspace_123", repository_id="repo_123", payload=payload),
                    policy=SourceCustodyPolicy.default(),
                    product_store=FailingProductAuthStore(),
                    telemetry_store=telemetry_store,
                )

                self.assertFalse(result.accepted)
                self.assertEqual(telemetry_store.records, [])
                self.assertEqual((result.errors[0].code, result.errors[0].field), expected_error)

    def test_non_deterministic_graph_metadata_is_rejected_without_writes(self) -> None:
        telemetry_store = InMemoryTelemetryStore()

        result = ingest(
            IngestionEnvelope(
                workspace_id="workspace_123",
                repository_id="repo_123",
                payload=_graph_metadata_submission(deterministic=False, metadata={"authority": "llm_enrichment"}),
            ),
            policy=SourceCustodyPolicy.default(),
            product_store=FailingProductAuthStore(),
            telemetry_store=telemetry_store,
        )

        self.assertFalse(result.accepted)
        self.assertEqual(telemetry_store.records, [])
        self.assertEqual(result.errors[0].code, "graph_metadata_not_deterministic")
        self.assertEqual(result.errors[0].field, "payload.deterministic")


def _snapshot_submission(
    *,
    index_hash: str = "sha256:index123",
    ingestion_health: Optional[Mapping[str, object]] = None,
) -> IndexSnapshotSubmission:
    return IndexSnapshotSubmission(
        snapshot_id="snapshot_123",
        repository_id="repo_123",
        indexer_id="indexer_123",
        commit_sha=COMMIT_SHA,
        index_hash=index_hash,
        source_hashes={"src/app.py": "sha256:file123"},
        freshness={"src/app.py": "current"},
        ingestion_health=ingestion_health or {"status": "healthy"},
        graph_metadata_ref="object://graphs/repo_123/snapshot_123.json",
    )


def _graph_metadata_submission(
    *,
    deterministic: bool = True,
    metadata: Optional[Mapping[str, object]] = None,
) -> GraphMetadataSubmission:
    return GraphMetadataSubmission(
        graph_id="graph_123",
        snapshot_id="snapshot_123",
        node_count=12,
        edge_count=18,
        deterministic=deterministic,
        graph_ref="object://graphs/repo_123/snapshot_123.json",
        metadata=metadata or {"authority": "deterministic"},
    )


if __name__ == "__main__":
    unittest.main()
