from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Mapping, Optional, Type, Union

from agentrail.server.product import InMemoryProductAuthStore, PRODUCT_AUTH_SUBMISSION_KINDS
from agentrail.server.telemetry import InMemoryTelemetryStore, TELEMETRY_SUBMISSION_KINDS


@dataclass(frozen=True)
class SourceCustodyPolicy:
    mode: str = "metadata_only"
    allow_bounded_snippets: bool = False
    max_snippet_chars: int = 0

    @classmethod
    def default(cls: Type["SourceCustodyPolicy"]) -> "SourceCustodyPolicy":
        return cls()


@dataclass(frozen=True)
class WorkspaceSubmission:
    workspace_id: str
    display_name: str
    source_custody_mode: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="workspace", init=False)


@dataclass(frozen=True)
class TeamSubmission:
    team_id: str
    workspace_id: str
    display_name: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="team", init=False)


@dataclass(frozen=True)
class ApiKeyAuthSubmission:
    api_key_id: str
    workspace_id: str
    key_hash: str
    scopes: List[str]
    team_id: Optional[str] = None
    actor_id: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="api_key_auth", init=False)


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
    team_id: Optional[str] = None
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
class CodebaseUnitSubmission:
    codebase_unit_id: str
    repository_id: str
    name: str
    root_path: str
    kind: str
    team_id: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="codebase_unit", init=False)


@dataclass(frozen=True)
class IndexerSubmission:
    indexer_id: str
    repository_id: str
    status: str
    last_seen_at: str
    team_id: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="indexer", init=False)


@dataclass(frozen=True)
class RunSubmission:
    run_id: str
    repository_id: str
    agent: str
    status: str
    started_at: str
    team_id: Optional[str] = None
    codebase_unit_id: Optional[str] = None
    indexer_id: Optional[str] = None
    api_key_id: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="run", init=False)


@dataclass(frozen=True)
class ReviewGateSubmission:
    review_gate_id: str
    run_id: str
    gate_type: str
    status: str
    decided_at: str
    evidence_ref: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="review_gate", init=False)


@dataclass(frozen=True)
class SourceCustodyPolicySubmission:
    policy_id: str
    workspace_id: str
    mode: str
    allow_bounded_snippets: bool
    max_snippet_chars: int
    repository_id: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="source_custody_policy", init=False)


@dataclass(frozen=True)
class BillingConfigurationSubmission:
    billing_configuration_id: str
    workspace_id: str
    plan: str
    billing_account_ref: str
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="billing_configuration", init=False)


@dataclass(frozen=True)
class RunEventSubmission:
    event_id: str
    run_id: str
    event_type: str
    phase: str
    severity: str
    occurred_at: str
    agent: Optional[str] = None
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
    agent: Optional[str] = None
    phase: Optional[str] = None
    event_type: str = "cost_incurred"
    severity: str = "info"
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="cost_event", init=False)


@dataclass(frozen=True)
class AuditEventSubmission:
    event_id: str
    actor_id: str
    action: str
    decision: str
    occurred_at: str
    run_id: Optional[str] = None
    agent: Optional[str] = None
    phase: Optional[str] = None
    event_type: str = "audit"
    severity: str = "info"
    provider_call: Mapping[str, object] = field(default_factory=dict)
    redaction: Mapping[str, object] = field(default_factory=dict)
    context_decision: Mapping[str, object] = field(default_factory=dict)
    policy_decision: Mapping[str, object] = field(default_factory=dict)
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="audit_event", init=False)


@dataclass(frozen=True)
class FailureEventSubmission:
    event_id: str
    run_id: str
    event_type: str
    phase: str
    severity: str
    occurred_at: str
    agent: Optional[str] = None
    failure_type: Optional[str] = None
    message: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="failure_event", init=False)


@dataclass(frozen=True)
class CommandEventSubmission:
    event_id: str
    run_id: str
    command: str
    event_type: str
    phase: str
    severity: str
    occurred_at: str
    agent: Optional[str] = None
    exit_code: Optional[int] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="command_event", init=False)


@dataclass(frozen=True)
class ContextEventSubmission:
    event_id: str
    run_id: str
    event_type: str
    phase: str
    severity: str
    occurred_at: str
    agent: Optional[str] = None
    context_pack_id: Optional[str] = None
    decision: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="context_event", init=False)


IngestionPayload = Union[
    WorkspaceSubmission,
    TeamSubmission,
    ApiKeyAuthSubmission,
    RepositorySubmission,
    CodebaseUnitSubmission,
    IndexerSubmission,
    RunSubmission,
    ReviewGateSubmission,
    SourceCustodyPolicySubmission,
    BillingConfigurationSubmission,
    IndexSnapshotSubmission,
    GraphMetadataSubmission,
    ContextPackMetadataSubmission,
    RunEventSubmission,
    CostEventSubmission,
    AuditEventSubmission,
    FailureEventSubmission,
    CommandEventSubmission,
    ContextEventSubmission,
]

_FIELD_CATALOG: Mapping[str, List[str]] = {
    "metadata": [
        "workspace.display_name",
        "workspace.metadata",
        "team.display_name",
        "team.metadata",
        "api_key_auth.scopes",
        "api_key_auth.actor_id",
        "repository.name",
        "repository.default_branch",
        "repository.team_id",
        "codebase_unit.name",
        "codebase_unit.root_path",
        "codebase_unit.kind",
        "indexer.status",
        "indexer.last_seen_at",
        "run.agent",
        "run.status",
        "run.started_at",
        "review_gate.gate_type",
        "review_gate.status",
        "source_custody_policy.mode",
        "source_custody_policy.allow_bounded_snippets",
        "source_custody_policy.max_snippet_chars",
        "billing_configuration.plan",
        "graph_metadata.node_count",
        "graph_metadata.edge_count",
        "graph_metadata.metadata",
        "run_event.event_type",
        "run_event.phase",
        "run_event.severity",
        "run_event.agent",
        "run_event.occurred_at",
        "cost_event.event_type",
        "cost_event.phase",
        "cost_event.severity",
        "cost_event.agent",
        "cost_event.occurred_at",
        "cost_event.provider",
        "cost_event.model",
        "audit_event.event_type",
        "audit_event.phase",
        "audit_event.severity",
        "audit_event.agent",
        "audit_event.occurred_at",
        "audit_event.action",
        "audit_event.decision",
        "audit_event.provider_call",
        "audit_event.redaction",
        "audit_event.context_decision",
        "audit_event.policy_decision",
        "failure_event.event_type",
        "failure_event.phase",
        "failure_event.severity",
        "failure_event.agent",
        "failure_event.occurred_at",
        "failure_event.failure_type",
        "failure_event.message",
        "command_event.event_type",
        "command_event.phase",
        "command_event.severity",
        "command_event.agent",
        "command_event.occurred_at",
        "command_event.command",
        "command_event.exit_code",
        "context_event.event_type",
        "context_event.phase",
        "context_event.severity",
        "context_event.agent",
        "context_event.occurred_at",
        "context_event.decision",
    ],
    "hashes": [
        "repository.commit_sha",
        "repository.source_hashes",
        "api_key_auth.key_hash",
        "index_snapshot.commit_sha",
        "index_snapshot.source_hashes",
        "context_pack_metadata.content_hash",
        "repository.bounded_snippets[].content_hash",
    ],
    "references": [
        "repository.remote_url",
        "workspace.workspace_id",
        "team.team_id",
        "api_key_auth.api_key_id",
        "repository.repository_id",
        "codebase_unit.codebase_unit_id",
        "codebase_unit.repository_id",
        "codebase_unit.team_id",
        "indexer.indexer_id",
        "indexer.repository_id",
        "indexer.team_id",
        "run.run_id",
        "run.repository_id",
        "run.team_id",
        "run.codebase_unit_id",
        "run.indexer_id",
        "run.api_key_id",
        "review_gate.review_gate_id",
        "review_gate.run_id",
        "review_gate.evidence_ref",
        "source_custody_policy.workspace_id",
        "source_custody_policy.repository_id",
        "billing_configuration.billing_configuration_id",
        "billing_configuration.workspace_id",
        "billing_configuration.billing_account_ref",
        "index_snapshot.graph_metadata_ref",
        "graph_metadata.graph_ref",
        "context_pack_metadata.artifact_ref",
        "context_pack_metadata.citations",
        "run_event.event_id",
        "run_event.run_id",
        "cost_event.event_id",
        "cost_event.run_id",
        "audit_event.event_id",
        "audit_event.run_id",
        "audit_event.actor_id",
        "failure_event.event_id",
        "failure_event.run_id",
        "command_event.event_id",
        "command_event.run_id",
        "context_event.event_id",
        "context_event.run_id",
        "context_event.context_pack_id",
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
class InMemoryIngestionStore(InMemoryTelemetryStore):
    pass


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
    product_store: InMemoryProductAuthStore,
    telemetry_store: InMemoryTelemetryStore,
) -> IngestionResult:
    errors = _validate_payload(envelope, policy)
    if errors:
        return IngestionResult(accepted=False, errors=errors)
    payload_kind = envelope.payload.submission_kind
    if payload_kind in PRODUCT_AUTH_SUBMISSION_KINDS:
        product_store.write(envelope)
    elif payload_kind in TELEMETRY_SUBMISSION_KINDS:
        telemetry_store.write(envelope)
    else:
        return IngestionResult(
            accepted=False,
            errors=[
                ValidationError(
                    code="unknown_submission_kind",
                    field="payload.submission_kind",
                    message=f"Unknown ingestion submission kind: {payload_kind}",
                )
            ],
        )
    return IngestionResult(accepted=True)
