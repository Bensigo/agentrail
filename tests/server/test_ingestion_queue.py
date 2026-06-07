from __future__ import annotations

import threading
import unittest

from agentrail.server.ingestion import (
    ArtifactReferenceSubmission,
    IngestionEnvelope,
    RunEventSubmission,
    SourceCustodyPolicy,
    WorkspaceSubmission,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.queue import (
    BatchWriter,
    IngestionQueue,
    flush_queue,
)
from agentrail.server.telemetry import InMemoryTelemetryStore


def _workspace_envelope(workspace_id: str = "ws_1") -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        payload=WorkspaceSubmission(
            workspace_id=workspace_id,
            display_name="Test Workspace",
            source_custody_mode="metadata_only",
        ),
    )


def _run_event_envelope(
    workspace_id: str = "ws_1",
    run_id: str = "run_1",
    event_id: str = "evt_1",
) -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        repository_id="repo_1",
        payload=RunEventSubmission(
            event_id=event_id,
            run_id=run_id,
            event_type="step_completed",
            phase="execute",
            severity="info",
            occurred_at="2026-06-07T00:00:00Z",
            agent="codex",
        ),
    )


def _artifact_envelope(
    workspace_id: str = "ws_1",
    artifact_id: str = "art_1",
) -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        repository_id="repo_1",
        payload=ArtifactReferenceSubmission(
            artifact_id=artifact_id,
            workspace_id=workspace_id,
            repository_id="repo_1",
            artifact_kind="log",
            uri="object://logs/run_1.jsonl",
            content_hash="sha256:abc123",
            size_bytes=1024,
            content_type="application/jsonl",
            run_id="run_1",
        ),
    )


class IngestionQueueTests(unittest.TestCase):

    def test_enqueue_accepts_valid_payloads(self) -> None:
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        result = queue.enqueue(_workspace_envelope())
        self.assertTrue(result.accepted, result.errors)
        self.assertEqual(queue.pending(), 1)

    def test_enqueue_rejects_invalid_payloads(self) -> None:
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        envelope = IngestionEnvelope(
            workspace_id="ws_1",
            repository_id="repo_1",
            payload=ArtifactReferenceSubmission(
                artifact_id="art_bad",
                workspace_id="ws_other",
                repository_id="repo_1",
                artifact_kind="log",
                uri="object://logs/bad.jsonl",
                content_hash="sha256:abc",
                size_bytes=100,
                run_id="run_1",
            ),
        )
        result = queue.enqueue(envelope)
        self.assertFalse(result.accepted)
        self.assertEqual(queue.pending(), 0)

    def test_backpressure_rejects_when_full(self) -> None:
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default(), _max_size=2)
        queue.enqueue(_workspace_envelope())
        queue.enqueue(_run_event_envelope())
        result = queue.enqueue(_artifact_envelope())
        self.assertFalse(result.accepted)
        self.assertEqual(result.errors[0].code, "queue_backpressure")
        self.assertEqual(queue.pending(), 2)

    def test_drain_returns_batch_in_order(self) -> None:
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_workspace_envelope())
        queue.enqueue(_run_event_envelope(event_id="evt_1"))
        queue.enqueue(_run_event_envelope(event_id="evt_2"))
        batch = queue.drain(batch_size=10)
        self.assertEqual(len(batch), 3)
        self.assertEqual([item.sequence for item in batch], [1, 2, 3])
        self.assertEqual(queue.pending(), 0)

    def test_drain_respects_batch_size(self) -> None:
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        for i in range(5):
            queue.enqueue(_run_event_envelope(event_id=f"evt_{i}"))
        batch = queue.drain(batch_size=3)
        self.assertEqual(len(batch), 3)
        self.assertEqual(queue.pending(), 2)


class BatchWriterTests(unittest.TestCase):

    def test_routes_product_auth_to_product_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_workspace_envelope())
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 1)
        self.assertEqual(len(result.failures), 0)
        self.assertEqual(len(product_store.workspaces), 1)
        self.assertEqual(len(telemetry_store.records), 0)

    def test_routes_telemetry_events_to_telemetry_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_run_event_envelope())
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 1)
        self.assertEqual(len(telemetry_store.run_events), 1)
        self.assertEqual(len(product_store.records), 0)

    def test_routes_artifact_references_to_telemetry_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_artifact_envelope())
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 1)
        self.assertEqual(len(telemetry_store.artifact_references), 1)

    def test_mixed_batch_routes_to_correct_stores(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_workspace_envelope())
        queue.enqueue(_run_event_envelope(event_id="evt_1"))
        queue.enqueue(_artifact_envelope())
        queue.enqueue(_run_event_envelope(event_id="evt_2"))
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 4)
        self.assertEqual(len(product_store.workspaces), 1)
        self.assertEqual(len(telemetry_store.run_events), 2)
        self.assertEqual(len(telemetry_store.artifact_references), 1)

    def test_writer_failure_produces_failure_evidence(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()

        class FailingTelemetryStore(InMemoryTelemetryStore):
            def write(self, envelope):
                raise RuntimeError("Simulated storage failure")

        writer = BatchWriter(product_store=product_store, telemetry_store=FailingTelemetryStore())
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_run_event_envelope())
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 0)
        self.assertEqual(len(result.failures), 1)
        self.assertIn("Simulated storage failure", result.failures[0].error)
        self.assertEqual(result.failures[0].sequence, 1)

    def test_partial_failure_writes_successful_items(self) -> None:
        call_count = 0

        class FailOnSecondWrite(InMemoryTelemetryStore):
            def write(self, envelope):
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    raise RuntimeError("Second write fails")
                super().write(envelope)

        product_store = InMemoryProductAuthStore()
        telemetry_store = FailOnSecondWrite()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_run_event_envelope(event_id="evt_1"))
        queue.enqueue(_run_event_envelope(event_id="evt_2"))
        queue.enqueue(_run_event_envelope(event_id="evt_3"))
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 2)
        self.assertEqual(len(result.failures), 1)
        self.assertEqual(result.failures[0].sequence, 2)

    def test_duplicate_queued_payloads_remain_idempotent(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        queue.enqueue(_workspace_envelope())
        queue.enqueue(_workspace_envelope())
        batch = queue.drain()
        result = writer.write_batch(batch)
        self.assertEqual(result.written, 2)
        self.assertEqual(len(product_store.workspaces), 2)


class FlushQueueTests(unittest.TestCase):

    def test_flush_processes_all_pending(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        for i in range(7):
            queue.enqueue(_run_event_envelope(event_id=f"evt_{i}"))
        results = flush_queue(queue, writer, batch_size=3)
        self.assertEqual(len(results), 3)
        self.assertEqual(results[0].written, 3)
        self.assertEqual(results[1].written, 3)
        self.assertEqual(results[2].written, 1)
        self.assertEqual(queue.pending(), 0)
        self.assertEqual(len(telemetry_store.run_events), 7)

    def test_flush_empty_queue_returns_empty(self) -> None:
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=InMemoryTelemetryStore(),
        )
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        results = flush_queue(queue, writer)
        self.assertEqual(results, [])


class HighVolumeTests(unittest.TestCase):

    def test_high_volume_preserves_ordering(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        event_count = 200
        for i in range(event_count):
            queue.enqueue(
                _run_event_envelope(
                    event_id=f"evt_{i:04d}",
                )
            )
        results = flush_queue(queue, writer, batch_size=50)
        self.assertEqual(sum(r.written for r in results), event_count)
        event_ids = [e.event_id for e in telemetry_store.run_events]
        self.assertEqual(event_ids, [f"evt_{i:04d}" for i in range(event_count)])

    def test_concurrent_enqueue_is_safe(self) -> None:
        queue = IngestionQueue(_policy=SourceCustodyPolicy.default())
        errors: list = []

        def enqueue_batch(start: int, count: int) -> None:
            for i in range(start, start + count):
                result = queue.enqueue(_run_event_envelope(event_id=f"evt_{i}"))
                if not result.accepted:
                    errors.append(f"evt_{i} rejected: {result.errors}")

        threads = [
            threading.Thread(target=enqueue_batch, args=(i * 50, 50))
            for i in range(4)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertEqual(queue.pending(), 200)

        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store)
        results = flush_queue(queue, writer, batch_size=50)
        total_written = sum(r.written for r in results)
        self.assertEqual(total_written, 200)


if __name__ == "__main__":
    unittest.main()
