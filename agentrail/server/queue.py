"""
Queue-backed buffering between ingestion acceptance and storage writes.

Design notes
------------
- IngestionQueue is a FIFO deque. NOT thread-safe; single-threaded prototype only.
  Production deployments should replace with a durable, thread-safe message broker.
- Accepted envelopes are enqueued immediately; storage writes are deferred until
  BatchWriter.flush() is called.
- Writer failures are recorded in WriterFailureSink without raising to the caller,
  so no envelope is silently lost and no false success is returned.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

from agentrail.server.ingestion import (
    IngestionEnvelope,
    IngestionResult,
    SourceCustodyPolicy,
    ValidationError,
    _validate_payload,
)
from agentrail.server.product import PRODUCT_AUTH_SUBMISSION_KINDS, ProductAuthStore
from agentrail.server.telemetry import TELEMETRY_SUBMISSION_KINDS, TelemetryStore


@dataclass
class FailedFlushRecord:
    """Inspectable evidence of a single writer failure."""

    envelope: IngestionEnvelope
    code: str
    message: str
    exception: Optional[Exception] = None


@dataclass
class WriterFailureSink:
    """
    Accumulates FailedFlushRecord entries so backpressure or writer failures
    produce inspectable evidence without claiming successful ingestion.

    Cross-flush accumulation: failures are never cleared between flush() calls.
    Each call to BatchWriter.flush() appends new failures to this sink's
    ``failures`` list. Callers that need per-flush isolation must inspect or
    drain ``failures`` between flushes themselves.
    """

    failures: List[FailedFlushRecord] = field(default_factory=list)

    def record(self, entry: FailedFlushRecord) -> None:
        self.failures.append(entry)

    def has_failures(self) -> bool:
        return bool(self.failures)

    def failure_codes(self) -> List[str]:
        return [f.code for f in self.failures]


@dataclass
class IngestionQueue:
    """
    FIFO queue of validated ingestion envelopes awaiting storage writes.

    NOT thread-safe. Single-threaded prototype only.
    """

    _queue: Deque[IngestionEnvelope] = field(default_factory=deque)

    def enqueue(self, envelope: IngestionEnvelope) -> None:
        self._queue.append(envelope)

    def dequeue_batch(self, max_size: Optional[int] = None) -> List[IngestionEnvelope]:
        """Return up to max_size envelopes in FIFO order, removing them from the queue."""
        if max_size is None:
            batch = list(self._queue)
            self._queue.clear()
            return batch
        batch: List[IngestionEnvelope] = []
        while self._queue and len(batch) < max_size:
            batch.append(self._queue.popleft())
        return batch

    def size(self) -> int:
        return len(self._queue)

    def is_empty(self) -> bool:
        return not self._queue


@dataclass
class BatchWriter:
    """
    Routes queued envelopes to product/auth, telemetry, or artifact-reference stores.

    - product/auth records → ProductAuthStore
    - telemetry events and artifact references → TelemetryStore
    - Writer exceptions are caught and recorded in failure_sink; they do not propagate.
    - Returns the number of successfully written envelopes.
    """

    product_store: ProductAuthStore
    telemetry_store: TelemetryStore
    failure_sink: WriterFailureSink

    def flush(self, queue: IngestionQueue, *, batch_size: Optional[int] = None) -> int:
        """
        Drain up to batch_size envelopes from queue and write each to its store.
        If batch_size is None, drains the entire queue.
        """
        batch = queue.dequeue_batch(batch_size)
        written = 0
        for envelope in batch:
            kind = envelope.payload.submission_kind
            try:
                if kind in PRODUCT_AUTH_SUBMISSION_KINDS:
                    self.product_store.write(envelope)
                    written += 1
                elif kind in TELEMETRY_SUBMISSION_KINDS:
                    self.telemetry_store.write(envelope)
                    written += 1
                else:
                    self.failure_sink.record(
                        FailedFlushRecord(
                            envelope=envelope,
                            code="unknown_submission_kind",
                            message=f"No writer registered for submission kind: {kind!r}",
                        )
                    )
            except Exception as exc:  # noqa: BLE001
                self.failure_sink.record(
                    FailedFlushRecord(
                        envelope=envelope,
                        code="writer_exception",
                        message=str(exc),
                        exception=exc,
                    )
                )
        return written


@dataclass
class QueuedIngestionPipeline:
    """
    Validates ingestion envelopes and enqueues accepted payloads for deferred writes.

    Callers receive an IngestionResult immediately after validation.
    No storage write happens at acceptance time — call BatchWriter.flush() to commit.
    """

    queue: IngestionQueue
    policy: SourceCustodyPolicy

    def accept(self, envelope: IngestionEnvelope) -> IngestionResult:
        """
        Validate and enqueue an envelope.

        Returns accepted=True when valid and enqueued.
        Returns accepted=False with errors when validation fails; nothing is enqueued.
        """
        errors = _validate_payload(envelope, self.policy)
        if errors:
            return IngestionResult(accepted=False, errors=errors)
        kind = envelope.payload.submission_kind
        if kind not in PRODUCT_AUTH_SUBMISSION_KINDS and kind not in TELEMETRY_SUBMISSION_KINDS:
            return IngestionResult(
                accepted=False,
                errors=[
                    ValidationError(
                        code="unknown_submission_kind",
                        field="payload.submission_kind",
                        message=f"Unknown ingestion submission kind: {kind!r}",
                    )
                ],
            )
        self.queue.enqueue(envelope)
        return IngestionResult(accepted=True)
