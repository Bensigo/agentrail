from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, List, Protocol

if TYPE_CHECKING:
    from agentrail.server.ingestion import IngestionEnvelope


class ProductAuthStore(Protocol):
    """Protocol for product/auth storage backends."""

    def write(self, envelope: "IngestionEnvelope") -> None: ...


PRODUCT_AUTH_SUBMISSION_KINDS = {
    "workspace",
    "team",
    "api_key_auth",
    "repository",
    "codebase_unit",
    "indexer",
    "run",
    "review_gate",
    "source_custody_policy",
    "billing_configuration",
}


@dataclass
class InMemoryProductAuthStore:
    records: List["IngestionEnvelope"] = field(default_factory=list)
    workspaces: List[object] = field(default_factory=list)
    teams: List[object] = field(default_factory=list)
    api_keys: List[object] = field(default_factory=list)
    repositories: List[object] = field(default_factory=list)
    codebase_units: List[object] = field(default_factory=list)
    indexers: List[object] = field(default_factory=list)
    runs: List[object] = field(default_factory=list)
    review_gates: List[object] = field(default_factory=list)
    source_custody_policies: List[object] = field(default_factory=list)
    billing_configurations: List[object] = field(default_factory=list)

    def write(self, envelope: "IngestionEnvelope") -> None:
        self.records.append(envelope)
        payload = envelope.payload
        kind = payload.submission_kind
        if kind == "workspace":
            self.workspaces.append(payload)
        elif kind == "team":
            self.teams.append(payload)
        elif kind == "api_key_auth":
            self.api_keys.append(payload)
        elif kind == "repository":
            self.repositories.append(payload)
        elif kind == "codebase_unit":
            self.codebase_units.append(payload)
        elif kind == "indexer":
            self.indexers.append(payload)
        elif kind == "run":
            self.runs.append(payload)
        elif kind == "review_gate":
            self.review_gates.append(payload)
        elif kind == "source_custody_policy":
            self.source_custody_policies.append(payload)
        elif kind == "billing_configuration":
            self.billing_configurations.append(payload)
