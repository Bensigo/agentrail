from __future__ import annotations

import threading
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
from agentrail.server.product import InMemoryProductAuthStore, PRODUCT_AUTH_SUBMISSION_KINDS
from agentrail.server.telemetry import InMemoryTelemetryStore, TELEMETRY_SUBMISSION_KINDS


@dataclass(frozen=True)
class QueuedEnvelope:
    envelope: IngestionEnvelope
    sequence: int


@dataclass(frozen=True)
class WriterFailure:
    envelope: IngestionEnvelope
    sequence: int
    error: str


@dataclass(frozen=True)
class BatchResult:
    written: int
    failures: List[WriterFailure] = field(default_factory=list)


@dataclass
class IngestionQueue:
    _policy: SourceCustodyPolicy
    _buffer: Deque[QueuedEnvelope] = field(default_factory=deque)
    _sequence: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _max_size: int = 10000

    def enqueue(self, envelope: IngestionEnvelope) -> IngestionResult:
        errors = _validate_payload(envelope, self._policy)
        if errors:
            return IngestionResult(accepted=False, errors=errors)
        with self._lock:
            if len(self._buffer) >= self._max_size:
                return IngestionResult(
                    accepted=False,
                    errors=[
                        ValidationError(
                            code="queue_backpressure",
                            field="queue",
                            message="Ingestion queue is full. Retry after the current batch is processed.",
                        )
                    ],
                )
            self._sequence += 1
            self._buffer.append(QueuedEnvelope(envelope=envelope, sequence=self._sequence))
        return IngestionResult(accepted=True)

    def drain(self, batch_size: int = 100) -> List[QueuedEnvelope]:
        with self._lock:
            count = min(batch_size, len(self._buffer))
            return [self._buffer.popleft() for _ in range(count)]

    def pending(self) -> int:
        with self._lock:
            return len(self._buffer)


@dataclass
class BatchWriter:
    product_store: InMemoryProductAuthStore
    telemetry_store: InMemoryTelemetryStore

    def write_batch(self, batch: List[QueuedEnvelope]) -> BatchResult:
        written = 0
        failures: List[WriterFailure] = []
        for item in batch:
            envelope = item.envelope
            kind = envelope.payload.submission_kind
            try:
                if kind in PRODUCT_AUTH_SUBMISSION_KINDS:
                    self.product_store.write(envelope)
                elif kind in TELEMETRY_SUBMISSION_KINDS:
                    self.telemetry_store.write(envelope)
                else:
                    failures.append(
                        WriterFailure(
                            envelope=envelope,
                            sequence=item.sequence,
                            error=f"Unknown submission kind: {kind}",
                        )
                    )
                    continue
                written += 1
            except Exception as exc:
                failures.append(
                    WriterFailure(
                        envelope=envelope,
                        sequence=item.sequence,
                        error=str(exc),
                    )
                )
        return BatchResult(written=written, failures=failures)


def flush_queue(
    queue: IngestionQueue,
    writer: BatchWriter,
    *,
    batch_size: int = 100,
) -> List[BatchResult]:
    results: List[BatchResult] = []
    while queue.pending() > 0:
        batch = queue.drain(batch_size)
        if not batch:
            break
        results.append(writer.write_batch(batch))
    return results
