from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import List, Optional


TELEMETRY_EVENT_SUBMISSION_KINDS = {
    "run_event",
    "cost_event",
    "audit_event",
    "failure_event",
    "command_event",
    "context_event",
}


TELEMETRY_SUBMISSION_KINDS = {
    "index_snapshot",
    "graph_metadata",
    "context_pack_metadata",
    "artifact_reference",
    *TELEMETRY_EVENT_SUBMISSION_KINDS,
}


@dataclass(frozen=True)
class TelemetryEventRecord:
    workspace_id: str
    repository_id: Optional[str]
    run_id: Optional[str]
    agent: Optional[str]
    phase: Optional[str]
    event_type: str
    severity: Optional[str]
    occurred_at: str
    event_id: str
    submission_kind: str
    payload: object


@dataclass
class InMemoryTelemetryStore:
    records: List["IngestionEnvelope"] = field(default_factory=list)
    index_snapshots: List[object] = field(default_factory=list)
    graph_metadata: List[object] = field(default_factory=list)
    context_pack_metadata: List[object] = field(default_factory=list)
    artifact_references: List[object] = field(default_factory=list)
    event_records: List[TelemetryEventRecord] = field(default_factory=list)
    run_events: List[object] = field(default_factory=list)
    cost_events: List[object] = field(default_factory=list)
    audit_events: List[object] = field(default_factory=list)
    failure_events: List[object] = field(default_factory=list)
    command_events: List[object] = field(default_factory=list)
    context_events: List[object] = field(default_factory=list)

    def write(self, envelope: "IngestionEnvelope") -> None:
        payload = envelope.payload
        kind = payload.submission_kind
        if _is_duplicate_idempotent_metadata(envelope, self.records):
            return
        self.records.append(envelope)
        if kind in TELEMETRY_EVENT_SUBMISSION_KINDS:
            self.event_records.append(_event_record_from_envelope(envelope))
        if kind == "index_snapshot":
            self.index_snapshots.append(payload)
        elif kind == "graph_metadata":
            self.graph_metadata.append(payload)
        elif kind == "context_pack_metadata":
            self.context_pack_metadata.append(payload)
        elif kind == "artifact_reference":
            self.artifact_references.append(payload)
        elif kind == "run_event":
            self.run_events.append(payload)
        elif kind == "cost_event":
            self.cost_events.append(payload)
        elif kind == "audit_event":
            self.audit_events.append(payload)
        elif kind == "failure_event":
            self.failure_events.append(payload)
        elif kind == "command_event":
            self.command_events.append(payload)
        elif kind == "context_event":
            self.context_events.append(payload)

    def query_events(
        self,
        *,
        workspace_id: Optional[str] = None,
        repository_id: Optional[str] = None,
        run_id: Optional[str] = None,
        agent: Optional[str] = None,
        phase: Optional[str] = None,
        event_type: Optional[str] = None,
        severity: Optional[str] = None,
        occurred_from: Optional[str] = None,
        occurred_to: Optional[str] = None,
    ) -> List[TelemetryEventRecord]:
        return [
            record
            for record in self.event_records
            if _matches(record, "workspace_id", workspace_id)
            and _matches(record, "repository_id", repository_id)
            and _matches(record, "run_id", run_id)
            and _matches(record, "agent", agent)
            and _matches(record, "phase", phase)
            and _matches(record, "event_type", event_type)
            and _matches(record, "severity", severity)
            and (occurred_from is None or record.occurred_at >= occurred_from)
            and (occurred_to is None or record.occurred_at <= occurred_to)
        ]


def _is_duplicate_idempotent_metadata(envelope: "IngestionEnvelope", records: List["IngestionEnvelope"]) -> bool:
    payload = envelope.payload
    kind = payload.submission_kind
    if kind == "index_snapshot":
        identity = _index_snapshot_identity(envelope)
    elif kind == "graph_metadata":
        identity = _graph_metadata_identity(envelope)
    else:
        return False
    return any(
        existing.payload == payload
        and (
            _index_snapshot_identity(existing)
            if kind == "index_snapshot"
            else _graph_metadata_identity(existing)
        )
        == identity
        for existing in records
        if existing.payload.submission_kind == kind
    )


def _index_snapshot_identity(envelope: "IngestionEnvelope") -> tuple[str, str, str, str, str, str, str]:
    payload = envelope.payload
    return (
        "index_snapshot",
        envelope.workspace_id,
        payload.repository_id,
        payload.indexer_id,
        payload.snapshot_id,
        payload.commit_sha,
        payload.index_hash,
    )


def _graph_metadata_identity(envelope: "IngestionEnvelope") -> tuple[str, str, str, str, str]:
    payload = envelope.payload
    return (
        "graph_metadata",
        envelope.workspace_id,
        envelope.repository_id or "",
        payload.snapshot_id,
        payload.graph_id,
    )


def _matches(record: TelemetryEventRecord, field_name: str, expected: Optional[str]) -> bool:
    return expected is None or getattr(record, field_name) == expected


def _event_record_from_envelope(envelope: "IngestionEnvelope") -> TelemetryEventRecord:
    payload = envelope.payload
    kind = payload.submission_kind
    return TelemetryEventRecord(
        workspace_id=envelope.workspace_id,
        repository_id=envelope.repository_id,
        run_id=_payload_filter_value(payload, "run_id"),
        agent=_payload_filter_value(payload, "agent"),
        phase=_payload_filter_value(payload, "phase"),
        event_type=_payload_filter_value(payload, "event_type") or _payload_filter_value(payload, "action") or kind,
        severity=_payload_filter_value(payload, "severity"),
        occurred_at=_payload_filter_value(payload, "occurred_at") or "",
        event_id=_payload_filter_value(payload, "event_id") or "",
        submission_kind=kind,
        payload=payload,
    )


def _payload_filter_value(payload: object, field_name: str) -> Optional[str]:
    value = getattr(payload, field_name, None)
    if isinstance(value, str):
        return value
    metadata = getattr(payload, "metadata", None)
    if isinstance(metadata, Mapping):
        metadata_value = metadata.get(field_name)
        if isinstance(metadata_value, str):
            return metadata_value
    return None
