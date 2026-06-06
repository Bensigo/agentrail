from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Mapping, Optional, Union


@dataclass(frozen=True)
class SourceCustodyPolicy:
    mode: str = "metadata_only"
    allow_bounded_snippets: bool = False
    max_snippet_chars: int = 0

    @classmethod
    def default(cls) -> "SourceCustodyPolicy":
        return cls()


@dataclass(frozen=True)
class WorkspaceSubmission:
    workspace_id: str
    display_name: str
    source_custody_mode: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="workspace", init=False)


@dataclass(frozen=True)
class RepositorySubmission:
    repository_id: str
    name: str
    default_branch: str
    remote_url: str
    commit_sha: str
    source_hashes: Mapping[str, str] = field(default_factory=dict)
    bounded_snippets: List["BoundedSnippet"] = field(default_factory=list)
    full_source: Optional[Mapping[str, str]] = None
    submission_kind: str = field(default="repository", init=False)


@dataclass(frozen=True)
class BoundedSnippet:
    path: str
    citation: str
    start_line: int
    end_line: int
    content: str
    content_hash: str


@dataclass(frozen=True)
class IndexSnapshotSubmission:
    snapshot_id: str
    repository_id: str
    commit_sha: str
    source_hashes: Mapping[str, str]
    freshness: Mapping[str, str]
    ingestion_health: Mapping[str, object]
    graph_metadata_ref: str
    submission_kind: str = field(default="index_snapshot", init=False)


@dataclass(frozen=True)
class GraphMetadataSubmission:
    graph_id: str
    snapshot_id: str
    node_count: int
    edge_count: int
    deterministic: bool
    graph_ref: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="graph_metadata", init=False)


@dataclass(frozen=True)
class ContextPackMetadataSubmission:
    context_pack_id: str
    target_kind: str
    target_id: str
    content_hash: str
    citations: List[str]
    artifact_ref: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="context_pack_metadata", init=False)


@dataclass(frozen=True)
class RunEventSubmission:
    event_id: str
    run_id: str
    event_type: str
    phase: str
    severity: str
    occurred_at: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="run_event", init=False)


@dataclass(frozen=True)
class CostEventSubmission:
    event_id: str
    run_id: str
    provider: str
    model: str
    cost_usd: float
    occurred_at: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="cost_event", init=False)


@dataclass(frozen=True)
class AuditEventSubmission:
    event_id: str
    actor_id: str
    action: str
    decision: str
    occurred_at: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="audit_event", init=False)


IngestionPayload = Union[
    WorkspaceSubmission,
    RepositorySubmission,
    IndexSnapshotSubmission,
    GraphMetadataSubmission,
    ContextPackMetadataSubmission,
    RunEventSubmission,
    CostEventSubmission,
    AuditEventSubmission,
]

_FIELD_CATALOG: Mapping[str, List[str]] = {
    "metadata": [
        "workspace.display_name",
        "workspace.metadata",
        "repository.name",
        "repository.default_branch",
        "graph_metadata.node_count",
        "graph_metadata.edge_count",
        "graph_metadata.metadata",
        "run_event.event_type",
        "run_event.phase",
        "run_event.severity",
        "cost_event.provider",
        "cost_event.model",
        "audit_event.action",
        "audit_event.decision",
    ],
    "hashes": [
        "repository.commit_sha",
        "repository.source_hashes",
        "index_snapshot.commit_sha",
        "index_snapshot.source_hashes",
        "context_pack_metadata.content_hash",
        "repository.bounded_snippets[].content_hash",
    ],
    "references": [
        "repository.remote_url",
        "index_snapshot.graph_metadata_ref",
        "graph_metadata.graph_ref",
        "context_pack_metadata.artifact_ref",
        "context_pack_metadata.citations",
    ],
    "bounded_snippets": [
        "repository.bounded_snippets[].path",
        "repository.bounded_snippets[].citation",
        "repository.bounded_snippets[].start_line",
        "repository.bounded_snippets[].end_line",
        "repository.bounded_snippets[].content",
        "repository.bounded_snippets[].content_hash",
    ],
    "forbidden_full_source": [
        "repository.full_source",
        "raw file contents outside bounded snippets",
        "complete source files",
        "source archives",
    ],
}


@dataclass(frozen=True)
class IngestionEnvelope:
    workspace_id: str
    payload: IngestionPayload
    repository_id: Optional[str] = None


@dataclass(frozen=True)
class ValidationError:
    code: str
    field: str
    message: str


@dataclass(frozen=True)
class IngestionResult:
    accepted: bool
    errors: List[ValidationError] = field(default_factory=list)


@dataclass
class InMemoryIngestionStore:
    records: List[IngestionEnvelope] = field(default_factory=list)

    def write(self, envelope: IngestionEnvelope) -> None:
        self.records.append(envelope)


def contract_field_catalog() -> Mapping[str, List[str]]:
    return {category: list(fields) for category, fields in _FIELD_CATALOG.items()}


def _validate_payload(envelope: IngestionEnvelope, policy: SourceCustodyPolicy) -> List[ValidationError]:
    errors: List[ValidationError] = []
    payload = envelope.payload
    if isinstance(payload, RepositorySubmission) and payload.full_source:
        errors.append(
            ValidationError(
                code="full_source_forbidden",
                field="payload.full_source",
                message=(
                    "Full source payloads are forbidden by the Source Custody Policy. "
                    "Submit metadata, hashes, references, or allowed bounded snippets instead."
                ),
            )
        )
    if isinstance(payload, RepositorySubmission) and payload.bounded_snippets and not policy.allow_bounded_snippets:
        errors.append(
            ValidationError(
                code="bounded_snippet_not_allowed",
                field="payload.bounded_snippets",
                message=(
                    "Bounded cited snippets require SourceCustodyPolicy.allow_bounded_snippets=True. "
                    "Default enterprise ingestion accepts metadata, hashes, and references only."
                ),
            )
        )
    if isinstance(payload, RepositorySubmission) and payload.bounded_snippets and policy.allow_bounded_snippets and policy.max_snippet_chars <= 0:
        errors.append(
            ValidationError(
                code="bounded_snippet_policy_unbounded",
                field="policy.max_snippet_chars",
                message=(
                    "SourceCustodyPolicy.max_snippet_chars must be greater than zero when "
                    "allow_bounded_snippets=True."
                ),
            )
        )
    if isinstance(payload, RepositorySubmission) and payload.bounded_snippets and policy.allow_bounded_snippets and policy.max_snippet_chars:
        for index, snippet in enumerate(payload.bounded_snippets):
            if len(snippet.content) > policy.max_snippet_chars:
                errors.append(
                    ValidationError(
                        code="bounded_snippet_too_large",
                        field=f"payload.bounded_snippets[{index}].content",
                        message=(
                            "Bounded snippet content exceeds SourceCustodyPolicy.max_snippet_chars. "
                            "Send a shorter cited snippet or metadata-only reference."
                        ),
                    )
                )
    if isinstance(payload, RepositorySubmission) and payload.bounded_snippets and policy.allow_bounded_snippets:
        for index, snippet in enumerate(payload.bounded_snippets):
            if not snippet.citation:
                errors.append(
                    ValidationError(
                        code="bounded_snippet_missing_citation",
                        field=f"payload.bounded_snippets[{index}].citation",
                        message="Bounded snippets must include a citation so reviewers can trace the source reference.",
                    )
                )
            if snippet.start_line < 1 or snippet.end_line < snippet.start_line:
                errors.append(
                    ValidationError(
                        code="bounded_snippet_invalid_line_range",
                        field=f"payload.bounded_snippets[{index}].start_line",
                        message="Bounded snippets must include a positive start_line and an end_line greater than or equal to start_line.",
                    )
                )
    return errors


def ingest(
    envelope: IngestionEnvelope,
    *,
    policy: SourceCustodyPolicy,
    store: InMemoryIngestionStore,
) -> IngestionResult:
    errors = _validate_payload(envelope, policy)
    if errors:
        return IngestionResult(accepted=False, errors=errors)
    store.write(envelope)
    return IngestionResult(accepted=True)
