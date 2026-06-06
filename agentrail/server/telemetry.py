from __future__ import annotations

from dataclasses import dataclass, field
from typing import List


TELEMETRY_SUBMISSION_KINDS = {
    "index_snapshot",
    "graph_metadata",
    "context_pack_metadata",
    "run_event",
    "cost_event",
    "audit_event",
}


@dataclass
class InMemoryTelemetryStore:
    records: List["IngestionEnvelope"] = field(default_factory=list)
    index_snapshots: List[object] = field(default_factory=list)
    graph_metadata: List[object] = field(default_factory=list)
    context_pack_metadata: List[object] = field(default_factory=list)
    run_events: List[object] = field(default_factory=list)
    cost_events: List[object] = field(default_factory=list)
    audit_events: List[object] = field(default_factory=list)

    def write(self, envelope: "IngestionEnvelope") -> None:
        self.records.append(envelope)
        payload = envelope.payload
        kind = payload.submission_kind
        if kind == "index_snapshot":
            self.index_snapshots.append(payload)
        elif kind == "graph_metadata":
            self.graph_metadata.append(payload)
        elif kind == "context_pack_metadata":
            self.context_pack_metadata.append(payload)
        elif kind == "run_event":
            self.run_events.append(payload)
        elif kind == "cost_event":
            self.cost_events.append(payload)
        elif kind == "audit_event":
            self.audit_events.append(payload)
