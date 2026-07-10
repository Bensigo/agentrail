"""
Tests for agentrail/server/queue.py

Coverage
--------
- High-volume queued events
- Batching (partial and full flush)
- Routing to product/auth, telemetry, and artifact-reference stores
- Queue processing preserves event ordering
- Duplicate queued payloads are idempotent when processed
- Backpressure / writer failure produces inspectable evidence without false success
"""
from __future__ import annotations

import unittest
from typing import List

from agentrail.server.ingestion import (
    ArtifactReferenceSubmission,
    IngestionEnvelope,
    IngestionResult,
    RepositorySubmission,
    RunEventSubmission,
    SourceCustodyPolicy,
    WorkspaceSubmission,
    RunSubmission,
)
from agentrail.server.product import InMemoryProductAuthStore
from agentrail.server.queue import (
    BatchWriter,
    FailedFlushRecord,
    IngestionQueue,
    QueuedIngestionPipeline,
    WriterFailureSink,
)
from agentrail.server.telemetry import InMemoryTelemetryStore


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _workspace_envelope(workspace_id: str = "ws_1") -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        payload=WorkspaceSubmission(
            workspace_id=workspace_id,
            display_name="Test Workspace",
            source_custody_mode="metadata_only",
        ),
    )


def _run_event_envelope(event_id: str, run_id: str = "run_1", workspace_id: str = "ws_1") -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        payload=RunEventSubmission(
            event_id=event_id,
            run_id=run_id,
            event_type="step_completed",
            phase="execute",
            severity="info",
            occurred_at="2026-01-01T00:00:00Z",
        ),
    )


def _artifact_reference_envelope(artifact_id: str, workspace_id: str = "ws_1") -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        repository_id="repo_1",
        payload=ArtifactReferenceSubmission(
            artifact_id=artifact_id,
            artifact_kind="log",
            workspace_id=workspace_id,
            repository_id="repo_1",
            uri="object://bucket/key",
            content_hash="sha256:abc123",
            size_bytes=1024,
            run_id="run_1",
        ),
    )


def _run_envelope(run_id: str = "run_1", workspace_id: str = "ws_1") -> IngestionEnvelope:
    return IngestionEnvelope(
        workspace_id=workspace_id,
        payload=RunSubmission(
            run_id=run_id,
            repository_id="repo_1",
            agent="claude",
            status="running",
            started_at="2026-01-01T00:00:00Z",
        ),
    )


def _make_pipeline() -> tuple[QueuedIngestionPipeline, IngestionQueue]:
    queue = IngestionQueue()
    pipeline = QueuedIngestionPipeline(queue=queue, policy=SourceCustodyPolicy.default())
    return pipeline, queue


def _make_batch_writer(
    product_store: InMemoryProductAuthStore | None = None,
    telemetry_store: InMemoryTelemetryStore | None = None,
    failure_sink: WriterFailureSink | None = None,
) -> BatchWriter:
    return BatchWriter(
        product_store=product_store or InMemoryProductAuthStore(),
        telemetry_store=telemetry_store or InMemoryTelemetryStore(),
        failure_sink=failure_sink or WriterFailureSink(),
    )


# ---------------------------------------------------------------------------
# IngestionQueue tests
# ---------------------------------------------------------------------------


class TestIngestionQueue(unittest.TestCase):
    def test_queue_starts_empty(self) -> None:
        q = IngestionQueue()
        self.assertTrue(q.is_empty())
        self.assertEqual(q.size(), 0)

    def test_enqueue_increases_size(self) -> None:
        q = IngestionQueue()
        q.enqueue(_workspace_envelope())
        self.assertEqual(q.size(), 1)
        self.assertFalse(q.is_empty())

    def test_dequeue_batch_returns_all_when_no_max_size(self) -> None:
        q = IngestionQueue()
        for i in range(5):
            q.enqueue(_run_event_envelope(f"evt_{i}"))
        batch = q.dequeue_batch()
        self.assertEqual(len(batch), 5)
        self.assertTrue(q.is_empty())

    def test_dequeue_batch_respects_max_size(self) -> None:
        q = IngestionQueue()
        for i in range(10):
            q.enqueue(_run_event_envelope(f"evt_{i}"))
        batch = q.dequeue_batch(max_size=3)
        self.assertEqual(len(batch), 3)
        self.assertEqual(q.size(), 7)

    def test_dequeue_preserves_fifo_order(self) -> None:
        q = IngestionQueue()
        event_ids = [f"evt_{i}" for i in range(20)]
        for eid in event_ids:
            q.enqueue(_run_event_envelope(eid))
        batch = q.dequeue_batch()
        returned_ids = [e.payload.event_id for e in batch]
        self.assertEqual(returned_ids, event_ids)

    def test_multiple_partial_batches_preserve_order(self) -> None:
        q = IngestionQueue()
        event_ids = [f"evt_{i}" for i in range(9)]
        for eid in event_ids:
            q.enqueue(_run_event_envelope(eid))
        all_batches: List[IngestionEnvelope] = []
        while not q.is_empty():
            all_batches.extend(q.dequeue_batch(max_size=3))
        returned_ids = [e.payload.event_id for e in all_batches]
        self.assertEqual(returned_ids, event_ids)


# ---------------------------------------------------------------------------
# WriterFailureSink tests
# ---------------------------------------------------------------------------


class TestWriterFailureSink(unittest.TestCase):
    def test_starts_empty(self) -> None:
        sink = WriterFailureSink()
        self.assertFalse(sink.has_failures())
        self.assertEqual(sink.failure_codes(), [])

    def test_records_failures(self) -> None:
        sink = WriterFailureSink()
        record = FailedFlushRecord(
            envelope=_workspace_envelope(),
            code="writer_exception",
            message="boom",
        )
        sink.record(record)
        self.assertTrue(sink.has_failures())
        self.assertEqual(sink.failure_codes(), ["writer_exception"])

    def test_multiple_failure_codes_are_inspectable(self) -> None:
        sink = WriterFailureSink()
        sink.record(FailedFlushRecord(envelope=_workspace_envelope(), code="code_a", message="a"))
        sink.record(FailedFlushRecord(envelope=_workspace_envelope(), code="code_b", message="b"))
        self.assertEqual(sink.failure_codes(), ["code_a", "code_b"])

    def test_failures_accumulate_across_flush_calls(self) -> None:
        """Failures from multiple flush() calls accumulate in the same sink (never cleared)."""

        class AlwaysBrokenProductStore(InMemoryProductAuthStore):
            def write(self, envelope: IngestionEnvelope) -> None:
                raise RuntimeError("store down")

        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=AlwaysBrokenProductStore(),
            telemetry_store=InMemoryTelemetryStore(),
            failure_sink=sink,
        )
        q = IngestionQueue()
        q.enqueue(_workspace_envelope("ws_1"))
        writer.flush(q)
        self.assertEqual(len(sink.failures), 1)

        q.enqueue(_workspace_envelope("ws_2"))
        writer.flush(q)
        # Failures from both flushes accumulate; sink is never cleared between calls.
        self.assertEqual(len(sink.failures), 2)
        self.assertEqual(sink.failures[0].envelope.workspace_id, "ws_1")
        self.assertEqual(sink.failures[1].envelope.workspace_id, "ws_2")


# ---------------------------------------------------------------------------
# BatchWriter routing tests
# ---------------------------------------------------------------------------


class TestBatchWriterRouting(unittest.TestCase):
    def test_product_auth_payload_writes_to_product_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store, failure_sink=sink)
        q = IngestionQueue()
        q.enqueue(_workspace_envelope())
        written = writer.flush(q)
        self.assertEqual(written, 1)
        self.assertEqual(len(product_store.workspaces), 1)
        self.assertEqual(len(telemetry_store.records), 0)
        self.assertFalse(sink.has_failures())

    def test_telemetry_event_writes_to_telemetry_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store, failure_sink=sink)
        q = IngestionQueue()
        q.enqueue(_run_event_envelope("evt_1"))
        written = writer.flush(q)
        self.assertEqual(written, 1)
        self.assertEqual(len(telemetry_store.run_events), 1)
        self.assertEqual(len(product_store.records), 0)
        self.assertFalse(sink.has_failures())

    def test_artifact_reference_writes_to_telemetry_store(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store, failure_sink=sink)
        q = IngestionQueue()
        q.enqueue(_artifact_reference_envelope("artifact_1"))
        written = writer.flush(q)
        self.assertEqual(written, 1)
        self.assertEqual(len(telemetry_store.artifact_references), 1)
        self.assertFalse(sink.has_failures())

    def test_mixed_payloads_route_to_correct_stores(self) -> None:
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store, failure_sink=sink)
        q = IngestionQueue()
        q.enqueue(_workspace_envelope())
        q.enqueue(_run_event_envelope("evt_1"))
        q.enqueue(_artifact_reference_envelope("artifact_1"))
        q.enqueue(_run_envelope())
        written = writer.flush(q)
        self.assertEqual(written, 4)
        self.assertEqual(len(product_store.workspaces), 1)
        self.assertEqual(len(product_store.runs), 1)
        self.assertEqual(len(telemetry_store.run_events), 1)
        self.assertEqual(len(telemetry_store.artifact_references), 1)
        self.assertFalse(sink.has_failures())


# ---------------------------------------------------------------------------
# Ordering tests
# ---------------------------------------------------------------------------


class TestBatchWriterOrdering(unittest.TestCase):
    def test_events_are_processed_in_enqueue_order(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
            failure_sink=sink,
        )
        q = IngestionQueue()
        event_ids = [f"evt_{i:04d}" for i in range(50)]
        for eid in event_ids:
            q.enqueue(_run_event_envelope(eid))
        writer.flush(q)
        written_ids = [r.event_id for r in telemetry_store.event_records]
        self.assertEqual(written_ids, event_ids)

    def test_multi_batch_flush_preserves_overall_ordering(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
            failure_sink=sink,
        )
        q = IngestionQueue()
        event_ids = [f"evt_{i:04d}" for i in range(30)]
        for eid in event_ids:
            q.enqueue(_run_event_envelope(eid))
        # Flush in batches of 10
        while not q.is_empty():
            writer.flush(q, batch_size=10)
        written_ids = [r.event_id for r in telemetry_store.event_records]
        self.assertEqual(written_ids, event_ids)


# ---------------------------------------------------------------------------
# High-volume tests
# ---------------------------------------------------------------------------


class TestHighVolume(unittest.TestCase):
    def test_high_volume_events_all_written(self) -> None:
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
            failure_sink=sink,
        )
        q = IngestionQueue()
        count = 1000
        for i in range(count):
            q.enqueue(_run_event_envelope(f"evt_{i}"))
        written = writer.flush(q)
        self.assertEqual(written, count)
        self.assertEqual(len(telemetry_store.run_events), count)
        self.assertFalse(sink.has_failures())
        self.assertTrue(q.is_empty())

    def test_pipeline_accepts_high_volume_without_writing(self) -> None:
        pipeline, queue = _make_pipeline()
        count = 500
        results = [pipeline.accept(_run_event_envelope(f"evt_{i}")) for i in range(count)]
        for result in results:
            self.assertTrue(result.accepted)
        self.assertEqual(queue.size(), count)


# ---------------------------------------------------------------------------
# Duplicate / idempotency tests
# ---------------------------------------------------------------------------


class TestDuplicateIdempotency(unittest.TestCase):
    def test_duplicate_telemetry_metadata_idempotent_on_flush(self) -> None:
        """Telemetry store already deduplicates idempotent metadata kinds."""
        from agentrail.server.ingestion import (
            IndexSnapshotSubmission,
        )

        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
            failure_sink=sink,
        )
        q = IngestionQueue()
        snapshot_envelope = IngestionEnvelope(
            workspace_id="ws_1",
            repository_id="repo_1",
            payload=IndexSnapshotSubmission(
                snapshot_id="snap_1",
                repository_id="repo_1",
                indexer_id="indexer_1",
                commit_sha="abc123",
                index_hash="sha256:def456",
                source_hashes={"file.py": "sha256:abc"},
                freshness={"status": "fresh"},
                ingestion_health={"status": "ok"},
                graph_metadata_ref="graph_ref_1",
            ),
        )
        # Enqueue the same envelope twice
        q.enqueue(snapshot_envelope)
        q.enqueue(snapshot_envelope)
        writer.flush(q)
        # Telemetry store deduplication should result in only one record
        self.assertEqual(len(telemetry_store.index_snapshots), 1)
        self.assertFalse(sink.has_failures())

    def test_duplicate_run_events_both_written(self) -> None:
        """Run events are not deduplicated — duplicates are written as-is."""
        telemetry_store = InMemoryTelemetryStore()
        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=telemetry_store,
            failure_sink=sink,
        )
        q = IngestionQueue()
        env = _run_event_envelope("evt_dup")
        q.enqueue(env)
        q.enqueue(env)
        written = writer.flush(q)
        self.assertEqual(written, 2)
        self.assertEqual(len(telemetry_store.run_events), 2)


# ---------------------------------------------------------------------------
# Writer failure / backpressure tests
# ---------------------------------------------------------------------------


class TestWriterFailure(unittest.TestCase):
    def test_product_store_exception_recorded_not_raised(self) -> None:
        class BrokenProductStore(InMemoryProductAuthStore):
            def write(self, envelope: IngestionEnvelope) -> None:
                raise RuntimeError("disk full")

        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=BrokenProductStore(),
            telemetry_store=InMemoryTelemetryStore(),
            failure_sink=sink,
        )
        q = IngestionQueue()
        q.enqueue(_workspace_envelope())
        # Should not raise
        written = writer.flush(q)
        self.assertEqual(written, 0)
        self.assertTrue(sink.has_failures())
        self.assertEqual(sink.failure_codes(), ["writer_exception"])
        self.assertIn("disk full", sink.failures[0].message)
        self.assertIsInstance(sink.failures[0].exception, RuntimeError)

    def test_telemetry_store_exception_recorded_not_raised(self) -> None:
        class BrokenTelemetryStore(InMemoryTelemetryStore):
            def write(self, envelope: IngestionEnvelope) -> None:
                raise OSError("network error")

        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=BrokenTelemetryStore(),
            failure_sink=sink,
        )
        q = IngestionQueue()
        q.enqueue(_run_event_envelope("evt_1"))
        written = writer.flush(q)
        self.assertEqual(written, 0)
        self.assertTrue(sink.has_failures())
        self.assertEqual(sink.failure_codes(), ["writer_exception"])

    def test_failure_evidence_includes_envelope(self) -> None:
        class BrokenProductStore(InMemoryProductAuthStore):
            def write(self, envelope: IngestionEnvelope) -> None:
                raise ValueError("store unavailable")

        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=BrokenProductStore(),
            telemetry_store=InMemoryTelemetryStore(),
            failure_sink=sink,
        )
        q = IngestionQueue()
        env = _workspace_envelope("ws_evidence")
        q.enqueue(env)
        writer.flush(q)
        self.assertEqual(sink.failures[0].envelope, env)
        self.assertEqual(sink.failures[0].envelope.workspace_id, "ws_evidence")

    def test_partial_batch_failure_writes_successes_and_records_failures(self) -> None:
        """Healthy envelopes before a failure should still be written."""

        call_count = 0

        class SelectivelyBrokenProductStore(InMemoryProductAuthStore):
            def write(self, envelope: IngestionEnvelope) -> None:
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    raise RuntimeError("second write fails")
                super().write(envelope)

        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=SelectivelyBrokenProductStore(),
            telemetry_store=InMemoryTelemetryStore(),
            failure_sink=sink,
        )
        q = IngestionQueue()
        q.enqueue(_workspace_envelope("ws_1"))
        q.enqueue(_workspace_envelope("ws_2"))  # This will fail
        q.enqueue(_workspace_envelope("ws_3"))
        written = writer.flush(q)
        self.assertEqual(written, 2)  # ws_1 and ws_3 succeed
        self.assertEqual(len(sink.failures), 1)
        self.assertEqual(sink.failures[0].code, "writer_exception")

    def test_unknown_submission_kind_goes_to_failure_sink(self) -> None:
        """If an envelope's kind is unrecognized, failure is recorded without exception."""
        from unittest.mock import MagicMock

        sink = WriterFailureSink()
        writer = _make_batch_writer(failure_sink=sink)
        q = IngestionQueue()
        # Craft an envelope with an unrecognized kind by monkey-patching
        envelope = _workspace_envelope()
        fake_payload = MagicMock()
        fake_payload.submission_kind = "completely_unknown"
        bad_envelope = IngestionEnvelope(workspace_id="ws_1", payload=fake_payload)
        q.enqueue(bad_envelope)
        written = writer.flush(q)
        self.assertEqual(written, 0)
        self.assertTrue(sink.has_failures())
        self.assertIn("unknown_submission_kind", sink.failure_codes())

    def test_no_false_success_on_writer_failure(self) -> None:
        """flush() must return 0 written, not claim success, when all writes fail."""

        class AlwaysBroken(InMemoryTelemetryStore):
            def write(self, envelope: IngestionEnvelope) -> None:
                raise RuntimeError("always broken")

        sink = WriterFailureSink()
        writer = BatchWriter(
            product_store=InMemoryProductAuthStore(),
            telemetry_store=AlwaysBroken(),
            failure_sink=sink,
        )
        q = IngestionQueue()
        for i in range(5):
            q.enqueue(_run_event_envelope(f"evt_{i}"))
        written = writer.flush(q)
        self.assertEqual(written, 0)
        self.assertEqual(len(sink.failures), 5)


# ---------------------------------------------------------------------------
# QueuedIngestionPipeline tests
# ---------------------------------------------------------------------------


class TestQueuedIngestionPipeline(unittest.TestCase):
    def test_valid_payload_accepted_and_enqueued(self) -> None:
        pipeline, queue = _make_pipeline()
        result = pipeline.accept(_workspace_envelope())
        self.assertTrue(result.accepted)
        self.assertEqual(queue.size(), 1)

    def test_invalid_payload_rejected_not_enqueued(self) -> None:
        pipeline, queue = _make_pipeline()
        # RepositorySubmission with full_source triggers validation error
        envelope = IngestionEnvelope(
            workspace_id="ws_1",
            payload=RepositorySubmission(
                repository_id="repo_1",
                name="my-repo",
                default_branch="main",
                remote_url="https://github.com/example/repo",
                commit_sha="abc123",
                full_source={"file.py": "def main(): pass"},
            ),
        )
        result = pipeline.accept(envelope)
        self.assertFalse(result.accepted)
        self.assertEqual(queue.size(), 0)
        self.assertTrue(any(e.code == "full_source_forbidden" for e in result.errors))

    def test_pipeline_does_not_write_to_stores_at_accept_time(self) -> None:
        """Acceptance must be non-blocking; writes happen only on flush()."""
        product_store = InMemoryProductAuthStore()
        telemetry_store = InMemoryTelemetryStore()
        queue = IngestionQueue()
        pipeline = QueuedIngestionPipeline(queue=queue, policy=SourceCustodyPolicy.default())

        for i in range(10):
            pipeline.accept(_run_event_envelope(f"evt_{i}"))

        # Nothing written yet
        self.assertEqual(len(telemetry_store.records), 0)
        self.assertEqual(len(product_store.records), 0)
        # Queue holds all 10
        self.assertEqual(queue.size(), 10)

        # Now flush
        sink = WriterFailureSink()
        writer = BatchWriter(product_store=product_store, telemetry_store=telemetry_store, failure_sink=sink)
        written = writer.flush(queue)
        self.assertEqual(written, 10)
        self.assertEqual(len(telemetry_store.run_events), 10)

    def test_pipeline_returns_accepted_before_flush(self) -> None:
        """IngestionResult.accepted is True immediately without waiting for flush."""
        pipeline, queue = _make_pipeline()
        results = [pipeline.accept(_run_event_envelope(f"evt_{i}")) for i in range(5)]
        for result in results:
            self.assertIsInstance(result, IngestionResult)
            self.assertTrue(result.accepted)
            self.assertEqual(result.errors, [])

    def test_pipeline_routes_all_supported_kinds(self) -> None:
        """Pipeline accepts product/auth, telemetry, and artifact-reference kinds."""
        pipeline, queue = _make_pipeline()
        pipeline.accept(_workspace_envelope())
        pipeline.accept(_run_envelope())
        pipeline.accept(_run_event_envelope("evt_1"))
        pipeline.accept(_artifact_reference_envelope("artifact_1"))
        self.assertEqual(queue.size(), 4)

    def test_unknown_submission_kind_rejected_by_pipeline(self) -> None:
        """accept() must reject envelopes with unrecognized submission kinds without enqueuing."""
        from unittest.mock import MagicMock

        pipeline, queue = _make_pipeline()
        fake_payload = MagicMock()
        fake_payload.submission_kind = "completely_unknown"
        bad_envelope = IngestionEnvelope(workspace_id="ws_1", payload=fake_payload)
        result = pipeline.accept(bad_envelope)
        self.assertFalse(result.accepted)
        self.assertEqual(queue.size(), 0)
        self.assertTrue(any(e.code == "unknown_submission_kind" for e in result.errors))

    def test_pipeline_rejects_unknown_submission_kind(self) -> None:
        """accept() returns accepted=False for unknown submission kinds and does not enqueue."""
        from unittest.mock import MagicMock

        pipeline, queue = _make_pipeline()
        fake_payload = MagicMock()
        fake_payload.submission_kind = "not_a_real_kind"
        envelope = IngestionEnvelope(workspace_id="ws_1", payload=fake_payload)
        result = pipeline.accept(envelope)
        self.assertFalse(result.accepted)
        self.assertEqual(queue.size(), 0)
        self.assertTrue(any(e.code == "unknown_submission_kind" for e in result.errors))


if __name__ == "__main__":
    unittest.main()
