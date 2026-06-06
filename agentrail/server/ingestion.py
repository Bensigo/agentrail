from __future__ import annotations

from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, field, fields, is_dataclass
from typing import List, Mapping, Optional, Type, Union

from agentrail.server.product import InMemoryProductAuthStore, PRODUCT_AUTH_SUBMISSION_KINDS
from agentrail.server.telemetry import InMemoryTelemetryStore, TELEMETRY_SUBMISSION_KINDS

MAX_INLINE_ARTIFACT_METADATA_CHARS = 4096

ARTIFACT_REFERENCE_KINDS = {
    "log",
    "transcript",
    "evidence_bundle",
    "screenshot",
    "index_snapshot",
    "context_pack",
}

RUN_ARTIFACT_REFERENCE_KINDS = {
    "log",
    "transcript",
    "evidence_bundle",
    "screenshot",
}

INLINE_ARTIFACT_BODY_KEYS = {
    "artifact_body",
    "artifact_payload",
    "body",
    "contents",
    "context_pack",
    "context_pack_artifact",
    "data",
    "evidence",
    "evidence_bundle",
    "full_transcript",
    "log",
    "logs",
    "raw",
    "raw_body",
    "raw_payload",
    "screenshot",
    "screenshot_bytes",
    "snapshot",
    "transcript",
    "transcript_text",
}

FULL_SOURCE_METADATA_KEYS = {
    "complete_source",
    "file_contents",
    "full_source",
    "full_source_files",
    "raw_file_contents",
    "raw_source",
    "source_archive",
    "source_files",
}

SNIPPET_METADATA_KEYS = {
    "bounded_snippet",
    "bounded_snippets",
    "code_snippet",
    "code_snippets",
    "snippet",
    "snippet_content",
    "snippets",
    "source_snippet",
    "source_snippets",
}


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
class ContextPackAnchor:
    anchor_id: str
    path: str
    citation: str
    reason: str
    start_line: Optional[int] = None
    end_line: Optional[int] = None
    symbol: Optional[str] = None
    source_hash: Optional[str] = None


@dataclass(frozen=True)
class ContextPackCitation:
    citation_id: str
    path: str
    source_hash: str
    start_line: Optional[int] = None
    end_line: Optional[int] = None
    artifact_ref: Optional[str] = None


@dataclass(frozen=True)
class ContextPackDecision:
    item_id: str
    citation: str
    reason: str
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class ContextPackBudget:
    max_input_tokens: int
    used_input_tokens: int
    max_output_tokens: int = 0


@dataclass(frozen=True)
class ContextPackQualityMetrics:
    required_source_coverage: float
    citation_coverage: float
    stale_or_denied_leakage: int
    precision_at_budget: Optional[float] = None
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class IndexSnapshotSubmission:
    snapshot_id: str
    repository_id: str
    indexer_id: str
    commit_sha: str
    index_hash: str
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
    workspace_id: str
    repository_id: str
    target_kind: str
    target_id: str
    content_hash: str
    source_hashes: Mapping[str, str]
    anchors: List[ContextPackAnchor]
    citations: List[ContextPackCitation]
    inclusions: List[ContextPackDecision]
    exclusions: List[ContextPackDecision]
    budgets: ContextPackBudget
    quality_metrics: ContextPackQualityMetrics
    run_id: Optional[str] = None
    pull_request_id: Optional[str] = None
    artifact_ref: Optional[str] = None
    bounded_snippets: List[BoundedSnippet] = field(default_factory=list)
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="context_pack_metadata", init=False)


@dataclass(frozen=True)
class ArtifactReferenceSubmission:
    artifact_id: str
    artifact_kind: str
    workspace_id: str
    uri: str
    content_hash: str
    size_bytes: int
    repository_id: Optional[str] = None
    run_id: Optional[str] = None
    context_pack_id: Optional[str] = None
    snapshot_id: Optional[str] = None
    content_type: Optional[str] = None
    metadata: Mapping[str, object] = field(default_factory=dict)
    submission_kind: str = field(default="artifact_reference", init=False)


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
    ArtifactReferenceSubmission,
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
        "index_snapshot.freshness",
        "index_snapshot.ingestion_health",
        "graph_metadata.deterministic",
        "graph_metadata.node_count",
        "graph_metadata.edge_count",
        "graph_metadata.metadata",
        "context_pack_metadata.target_kind",
        "context_pack_metadata.target_id",
        "context_pack_metadata.anchors[].reason",
        "context_pack_metadata.inclusions[].reason",
        "context_pack_metadata.exclusions[].reason",
        "context_pack_metadata.budgets",
        "context_pack_metadata.quality_metrics",
        "context_pack_metadata.metadata",
        "artifact_reference.artifact_kind",
        "artifact_reference.size_bytes",
        "artifact_reference.content_type",
        "artifact_reference.metadata",
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
        "index_snapshot.index_hash",
        "index_snapshot.source_hashes",
        "context_pack_metadata.content_hash",
        "context_pack_metadata.source_hashes",
        "context_pack_metadata.anchors[].source_hash",
        "context_pack_metadata.citations[].source_hash",
        "artifact_reference.content_hash",
        "repository.bounded_snippets[].content_hash",
        "context_pack_metadata.bounded_snippets[].content_hash",
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
        "index_snapshot.snapshot_id",
        "index_snapshot.repository_id",
        "index_snapshot.indexer_id",
        "index_snapshot.graph_metadata_ref",
        "graph_metadata.graph_id",
        "graph_metadata.snapshot_id",
        "graph_metadata.graph_ref",
        "context_pack_metadata.context_pack_id",
        "context_pack_metadata.workspace_id",
        "context_pack_metadata.repository_id",
        "context_pack_metadata.run_id",
        "context_pack_metadata.pull_request_id",
        "context_pack_metadata.anchors[].path",
        "context_pack_metadata.anchors[].citation",
        "context_pack_metadata.citations[].path",
        "context_pack_metadata.citations[].artifact_ref",
        "context_pack_metadata.inclusions[].item_id",
        "context_pack_metadata.inclusions[].citation",
        "context_pack_metadata.exclusions[].item_id",
        "context_pack_metadata.exclusions[].citation",
        "context_pack_metadata.artifact_ref",
        "context_pack_metadata.citations",
        "artifact_reference.artifact_id",
        "artifact_reference.workspace_id",
        "artifact_reference.repository_id",
        "artifact_reference.run_id",
        "artifact_reference.context_pack_id",
        "artifact_reference.snapshot_id",
        "artifact_reference.uri",
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
        "context_pack_metadata.bounded_snippets[].path",
        "context_pack_metadata.bounded_snippets[].citation",
        "context_pack_metadata.bounded_snippets[].start_line",
        "context_pack_metadata.bounded_snippets[].end_line",
        "context_pack_metadata.bounded_snippets[].content",
        "context_pack_metadata.bounded_snippets[].content_hash",
    ],
    "forbidden_full_source": [
        "repository.full_source",
        "context_pack_metadata.full_source",
        "context_pack_metadata.metadata.source_files",
        "large inline artifact bodies in metadata",
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
    errors.extend(_validate_no_large_inline_artifact_bodies(payload))
    if isinstance(payload, IndexSnapshotSubmission):
        errors.extend(_validate_index_snapshot(envelope, payload, policy))
    if isinstance(payload, GraphMetadataSubmission):
        errors.extend(_validate_graph_metadata(payload, policy))
    if isinstance(payload, ContextPackMetadataSubmission):
        errors.extend(_validate_context_pack_metadata(envelope, payload, policy))
    if isinstance(payload, ArtifactReferenceSubmission):
        errors.extend(_validate_artifact_reference(envelope, payload))
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
    if isinstance(payload, RepositorySubmission):
        errors.extend(_validate_bounded_snippets(payload.bounded_snippets, policy, "payload.bounded_snippets"))
    return errors


def _validate_index_snapshot(
    envelope: IngestionEnvelope,
    payload: IndexSnapshotSubmission,
    policy: SourceCustodyPolicy,
) -> List[ValidationError]:
    errors: List[ValidationError] = []
    if not envelope.repository_id:
        errors.append(
            ValidationError(
                code="index_snapshot_repository_required",
                field="envelope.repository_id",
                message="Index snapshot ingestion requires a repository_id in the envelope for stable snapshot identity.",
            )
        )
    elif payload.repository_id != envelope.repository_id:
        errors.append(
            ValidationError(
                code="index_snapshot_repository_mismatch",
                field="payload.repository_id",
                message="Index snapshot repository_id must match the ingestion envelope repository_id.",
            )
        )
    if not payload.snapshot_id:
        errors.append(
            ValidationError(
                code="index_snapshot_identity_required",
                field="payload.snapshot_id",
                message="Index snapshot identity requires a snapshot_id.",
            )
        )
    if not payload.commit_sha:
        errors.append(
            ValidationError(
                code="index_snapshot_identity_required",
                field="payload.commit_sha",
                message="Index snapshot identity requires a commit_sha.",
            )
        )
    if not payload.indexer_id:
        errors.append(
            ValidationError(
                code="index_snapshot_identity_required",
                field="payload.indexer_id",
                message="Index snapshot identity requires an indexer_id.",
            )
        )
    if not payload.index_hash:
        errors.append(
            ValidationError(
                code="index_snapshot_identity_required",
                field="payload.index_hash",
                message="Index snapshot identity requires an index_hash.",
            )
        )
    errors.extend(_validate_source_custody_metadata(payload, policy))
    return errors


def _validate_graph_metadata(
    payload: GraphMetadataSubmission,
    policy: SourceCustodyPolicy,
) -> List[ValidationError]:
    errors: List[ValidationError] = []
    if not payload.deterministic:
        errors.append(
            ValidationError(
                code="graph_metadata_not_deterministic",
                field="payload.deterministic",
                message="Graph metadata ingestion accepts deterministic graph metadata only; LLM enrichment is not authoritative graph evidence.",
            )
        )
    errors.extend(_validate_source_custody_metadata(payload, policy))
    return errors


def _validate_context_pack_metadata(
    envelope: IngestionEnvelope,
    payload: ContextPackMetadataSubmission,
    policy: SourceCustodyPolicy,
) -> List[ValidationError]:
    errors: List[ValidationError] = []
    if payload.workspace_id != envelope.workspace_id:
        errors.append(
            ValidationError(
                code="context_pack_workspace_mismatch",
                field="payload.workspace_id",
                message="Context-pack metadata workspace_id must match the ingestion envelope workspace_id.",
            )
        )
    if envelope.repository_id is not None and payload.repository_id != envelope.repository_id:
        errors.append(
            ValidationError(
                code="context_pack_repository_mismatch",
                field="payload.repository_id",
                message="Context-pack metadata repository_id must match the ingestion envelope repository_id.",
            )
        )
    if not payload.context_pack_id:
        errors.append(
            ValidationError(
                code="context_pack_identity_required",
                field="payload.context_pack_id",
                message="Context-pack metadata requires a context_pack_id.",
            )
        )
    if not payload.repository_id:
        errors.append(
            ValidationError(
                code="context_pack_identity_required",
                field="payload.repository_id",
                message="Context-pack metadata requires a repository_id.",
            )
        )
    if not payload.run_id and not payload.pull_request_id:
        errors.append(
            ValidationError(
                code="context_pack_association_required",
                field="payload.run_id",
                message="Context-pack metadata must be associated with a run_id or pull_request_id.",
            )
        )
    if not payload.source_hashes:
        errors.append(
            ValidationError(
                code="context_pack_source_hashes_required",
                field="payload.source_hashes",
                message="Context-pack metadata must include source hashes for cited source inventory.",
            )
        )
    if not payload.anchors:
        errors.append(
            ValidationError(
                code="context_pack_anchors_required",
                field="payload.anchors",
                message="Context-pack metadata must include at least one anchor and inclusion reason.",
            )
        )
    if not payload.citations:
        errors.append(
            ValidationError(
                code="context_pack_citations_required",
                field="payload.citations",
                message="Context-pack metadata must include citations for included evidence.",
            )
        )
    if not payload.inclusions:
        errors.append(
            ValidationError(
                code="context_pack_inclusions_required",
                field="payload.inclusions",
                message="Context-pack metadata must include inclusion reasons for selected evidence.",
            )
        )
    if payload.artifact_ref is not None and not payload.artifact_ref.startswith("object://"):
        errors.append(
            ValidationError(
                code="context_pack_artifact_ref_not_object_ref",
                field="payload.artifact_ref",
                message="Context-pack artifact references must point at an object-storage URI.",
            )
        )
    errors.extend(_validate_source_custody_metadata(payload, policy))
    errors.extend(_validate_bounded_snippets(payload.bounded_snippets, policy, "payload.bounded_snippets"))
    return errors


def _validate_bounded_snippets(
    snippets: List[BoundedSnippet],
    policy: SourceCustodyPolicy,
    field_prefix: str,
) -> List[ValidationError]:
    if not snippets:
        return []
    if not policy.allow_bounded_snippets:
        return [
            ValidationError(
                code="bounded_snippet_not_allowed",
                field=field_prefix,
                message=(
                    "Bounded cited snippets require SourceCustodyPolicy.allow_bounded_snippets=True. "
                    "Default enterprise ingestion accepts metadata, hashes, and references only."
                ),
            )
        ]
    if policy.max_snippet_chars <= 0:
        return [
            ValidationError(
                code="bounded_snippet_policy_unbounded",
                field="policy.max_snippet_chars",
                message=(
                    "SourceCustodyPolicy.max_snippet_chars must be greater than zero when "
                    "allow_bounded_snippets=True."
                ),
            )
        ]
    errors: List[ValidationError] = []
    for index, snippet in enumerate(snippets):
        if len(snippet.content) > policy.max_snippet_chars:
            errors.append(
                ValidationError(
                    code="bounded_snippet_too_large",
                    field=f"{field_prefix}[{index}].content",
                    message=(
                        "Bounded snippet content exceeds SourceCustodyPolicy.max_snippet_chars. "
                        "Send a shorter cited snippet or metadata-only reference."
                    ),
                )
            )
        if not snippet.citation:
            errors.append(
                ValidationError(
                    code="bounded_snippet_missing_citation",
                    field=f"{field_prefix}[{index}].citation",
                    message="Bounded snippets must include a citation so reviewers can trace the source reference.",
                )
            )
        if snippet.start_line < 1 or snippet.end_line < snippet.start_line:
            errors.append(
                ValidationError(
                    code="bounded_snippet_invalid_line_range",
                    field=f"{field_prefix}[{index}].start_line",
                    message="Bounded snippets must include a positive start_line and an end_line greater than or equal to start_line.",
                )
            )
    return errors


def _validate_no_large_inline_artifact_bodies(payload: IngestionPayload) -> List[ValidationError]:
    errors: List[ValidationError] = []
    if not is_dataclass(payload):
        return errors
    for payload_field in fields(payload):
        value = getattr(payload, payload_field.name)
        if isinstance(value, MappingABC) or is_dataclass(value):
            errors.extend(_find_large_inline_artifact_bodies(value, f"payload.{payload_field.name}"))
    return errors


def _validate_source_custody_metadata(payload: IngestionPayload, policy: SourceCustodyPolicy) -> List[ValidationError]:
    errors: List[ValidationError] = []
    if not is_dataclass(payload):
        return errors
    for payload_field in fields(payload):
        if payload_field.name == "bounded_snippets":
            continue
        value = getattr(payload, payload_field.name)
        if isinstance(value, (MappingABC, list)) or is_dataclass(value):
            errors.extend(_find_forbidden_source_custody_metadata(value, f"payload.{payload_field.name}", policy))
    return errors


def _find_forbidden_source_custody_metadata(
    value: object,
    field_path: str,
    policy: SourceCustodyPolicy,
) -> List[ValidationError]:
    if _is_full_source_metadata_field(field_path):
        return [
            ValidationError(
                code="full_source_forbidden",
                field=field_path,
                message=(
                    "Full source payloads are forbidden by the Source Custody Policy. "
                    "Submit metadata, hashes, references, or allowed bounded snippets instead."
                ),
            )
        ]
    if _is_snippet_metadata_field(field_path):
        if not policy.allow_bounded_snippets:
            return [
                ValidationError(
                    code="bounded_snippet_not_allowed",
                    field=field_path,
                    message=(
                        "Bounded cited snippets require SourceCustodyPolicy.allow_bounded_snippets=True. "
                        "Default enterprise ingestion accepts metadata, hashes, and references only."
                    ),
                )
            ]
        if policy.max_snippet_chars <= 0:
            return [
                ValidationError(
                    code="bounded_snippet_policy_unbounded",
                    field="policy.max_snippet_chars",
                    message=(
                        "SourceCustodyPolicy.max_snippet_chars must be greater than zero when "
                        "allow_bounded_snippets=True."
                    ),
                )
            ]
        return [
            ValidationError(
                code="bounded_snippet_metadata_unstructured",
                field=field_path,
                message=(
                    "Snippet-like metadata fields are not accepted as arbitrary metadata. "
                    "Use the typed bounded_snippets field with citation, line bounds, content, and content_hash."
                ),
            )
        ]
    errors: List[ValidationError] = []
    if isinstance(value, MappingABC):
        for key, nested_value in value.items():
            if isinstance(key, str):
                errors.extend(_find_forbidden_source_custody_metadata(nested_value, f"{field_path}.{key}", policy))
    elif isinstance(value, list):
        for index, nested_value in enumerate(value):
            errors.extend(_find_forbidden_source_custody_metadata(nested_value, f"{field_path}[{index}]", policy))
    elif is_dataclass(value):
        for nested_field in fields(value):
            if nested_field.name == "bounded_snippets":
                continue
            nested_value = getattr(value, nested_field.name)
            if isinstance(nested_value, (MappingABC, list)) or is_dataclass(nested_value):
                errors.extend(
                    _find_forbidden_source_custody_metadata(
                        nested_value,
                        f"{field_path}.{nested_field.name}",
                        policy,
                    )
                )
    return errors


def _is_full_source_metadata_field(field_path: str) -> bool:
    normalized = field_path.replace("[", ".").replace("]", "")
    field_name = normalized.split(".")[-1].lower()
    return field_name in FULL_SOURCE_METADATA_KEYS


def _is_snippet_metadata_field(field_path: str) -> bool:
    normalized = field_path.replace("[", ".").replace("]", "")
    field_name = normalized.split(".")[-1].lower()
    return field_name in SNIPPET_METADATA_KEYS


def _find_large_inline_artifact_bodies(value: object, field_path: str) -> List[ValidationError]:
    if _is_inline_artifact_body_field(field_path) and _estimated_inline_size(value) > MAX_INLINE_ARTIFACT_METADATA_CHARS:
        return [
            ValidationError(
                code="inline_artifact_body_forbidden",
                field=field_path,
                message=(
                    "Large artifact bodies must be stored as object-storage references with "
                    "ArtifactReferenceSubmission metadata, not inline product/auth or telemetry metadata."
                ),
            )
        ]
    errors: List[ValidationError] = []
    if isinstance(value, MappingABC):
        for key, nested_value in value.items():
            if isinstance(key, str):
                errors.extend(_find_large_inline_artifact_bodies(nested_value, f"{field_path}.{key}"))
    elif isinstance(value, list):
        for index, nested_value in enumerate(value):
            errors.extend(_find_large_inline_artifact_bodies(nested_value, f"{field_path}[{index}]"))
    elif is_dataclass(value):
        for nested_field in fields(value):
            nested_value = getattr(value, nested_field.name)
            if isinstance(nested_value, (MappingABC, list)) or is_dataclass(nested_value):
                errors.extend(_find_large_inline_artifact_bodies(nested_value, f"{field_path}.{nested_field.name}"))
    return errors


def _is_inline_artifact_body_field(field_path: str) -> bool:
    normalized = field_path.replace("[", ".").replace("]", "")
    field_name = normalized.split(".")[-1].lower()
    return field_name in INLINE_ARTIFACT_BODY_KEYS


def _estimated_inline_size(value: object) -> int:
    if isinstance(value, str):
        return len(value)
    if isinstance(value, bytes):
        return len(value)
    if isinstance(value, MappingABC):
        return sum(len(str(key)) + _estimated_inline_size(nested_value) for key, nested_value in value.items())
    if isinstance(value, list):
        return sum(_estimated_inline_size(item) for item in value)
    return len(str(value))


def _validate_artifact_reference(envelope: IngestionEnvelope, payload: ArtifactReferenceSubmission) -> List[ValidationError]:
    errors: List[ValidationError] = []
    if payload.artifact_kind not in ARTIFACT_REFERENCE_KINDS:
        errors.append(
            ValidationError(
                code="artifact_kind_not_allowed",
                field="payload.artifact_kind",
                message="Artifact references must use one of the allowed large artifact kinds.",
            )
        )
    if payload.workspace_id != envelope.workspace_id:
        errors.append(
            ValidationError(
                code="artifact_workspace_mismatch",
                field="payload.workspace_id",
                message="Artifact reference workspace_id must match the ingestion envelope workspace_id.",
            )
        )
    if envelope.repository_id is not None and payload.repository_id is not None and payload.repository_id != envelope.repository_id:
        errors.append(
            ValidationError(
                code="artifact_repository_mismatch",
                field="payload.repository_id",
                message="Artifact reference repository_id must match the ingestion envelope repository_id when both are present.",
            )
        )
    if not payload.repository_id:
        errors.append(
            ValidationError(
                code="artifact_repository_association_required",
                field="payload.repository_id",
                message="Artifact references must carry a repository_id so stored metadata can be associated without inline bodies.",
            )
        )
    if payload.artifact_kind in RUN_ARTIFACT_REFERENCE_KINDS and not payload.run_id:
        errors.append(
            ValidationError(
                code="artifact_run_association_required",
                field="payload.run_id",
                message="Log, transcript, evidence bundle, and screenshot artifact references must carry a run_id.",
            )
        )
    if payload.artifact_kind == "index_snapshot" and not payload.snapshot_id:
        errors.append(
            ValidationError(
                code="artifact_snapshot_association_required",
                field="payload.snapshot_id",
                message="Index snapshot artifact references must carry a snapshot_id.",
            )
        )
    if payload.artifact_kind == "context_pack" and not payload.context_pack_id:
        errors.append(
            ValidationError(
                code="artifact_context_pack_association_required",
                field="payload.context_pack_id",
                message="Context-pack artifact references must carry a context_pack_id.",
            )
        )
    if not payload.uri.startswith("object://"):
        errors.append(
            ValidationError(
                code="artifact_uri_not_object_ref",
                field="payload.uri",
                message="Artifact references must point at an object-storage URI.",
            )
        )
    if payload.size_bytes <= 0:
        errors.append(
            ValidationError(
                code="artifact_size_invalid",
                field="payload.size_bytes",
                message="Artifact references must include a positive size_bytes value.",
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
