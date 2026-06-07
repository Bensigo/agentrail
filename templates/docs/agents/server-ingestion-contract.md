# Server Ingestion Contract

AgentRail server ingestion is metadata-first. The local indexer or runner may submit workspace, team, API key auth metadata, repository, codebase unit, indexer, run, review gate, source custody policy, billing configuration, index snapshot, graph metadata, context-pack metadata, artifact references, run event, cost event, and audit event records without uploading full source code or large artifact bodies.

The first contract is represented by `agentrail.server.ingestion` and is intentionally a service-domain prototype, not a production HTTP API or storage writer.

## Storage Routing

Product/auth and workflow truth records use `InMemoryProductAuthStore`, the local prototype stand-in for Postgres product state. This includes workspaces, teams, API key auth metadata, repositories, codebase units, indexers, runs, review gates, source custody policies, and billing configuration.

Append-only telemetry and artifact metadata use `InMemoryTelemetryStore`, the local prototype stand-in for ClickHouse-style event or analytics state. This includes index snapshots, graph metadata, context-pack metadata, artifact references, run events, cost events, audit events, failure events, command events, and context events.

Tests must prove product/auth writes do not call the telemetry store path.

## Snapshot And Graph Idempotency

Index snapshot ingestion is keyed by stable local-indexer identity: envelope workspace ID, repository ID, indexer ID, snapshot ID, commit SHA, and index hash. Exact repeated submissions of the same snapshot identity and payload are accepted as idempotent no-ops and do not duplicate telemetry records.

Changed snapshot metadata under the same identity is stored as a new telemetry record so prior snapshot evidence remains intact. This prototype preserves both records rather than overwriting the older payload.

Graph metadata ingestion is deterministic-only. Exact repeated graph metadata submissions for the same workspace, repository, snapshot, and graph identity are accepted as idempotent no-ops. Non-deterministic graph enrichment is rejected as authoritative graph metadata.

Context-pack metadata ingestion is keyed by workspace, repository, context pack ID, run or pull request association, and content hash. Exact repeated submissions of the same context-pack metadata identity and payload are accepted as idempotent no-ops. Changed metadata under the same pack identity is stored as a new telemetry record so audit history is preserved.

## Source Custody Policy

Default policy:

```json
{
  "mode": "metadata_only",
  "allow_bounded_snippets": false,
  "max_snippet_chars": 0
}
```

Full source content is forbidden by this contract. Large logs, transcripts, evidence bundles, screenshots, index snapshots, and context-pack artifacts are also forbidden inline; submit them as object-storage artifact references with bounded metadata instead. Bounded cited snippets may be accepted only when Source Custody Policy explicitly sets `allow_bounded_snippets` and a nonzero `max_snippet_chars`.

Context-pack metadata may include bounded snippets only in the typed `bounded_snippets` field. Snippet-like arbitrary metadata keys such as `source_snippets` or `snippet_content` are rejected so callers cannot bypass citation, line-bound, and hash requirements.

Invalid custody and payload combinations must return validation errors and must not write records.

## Payload Kinds

- `workspace`: workspace identity, display metadata, and source custody mode.
- `team`: workspace-scoped team identity and display metadata.
- `api_key_auth`: workspace-scoped API key hash, scopes, optional team, and actor metadata for ingestion attribution.
- `repository`: repository identity, optional team, remote reference, commit SHA, source hashes, and optional bounded snippets.
- `codebase_unit`: repository-scoped unit identity, root path, kind, optional team, and detection metadata.
- `indexer`: repository-scoped indexer identity, optional team, health state, and last-seen metadata.
- `run`: product/workflow run truth with repository, optional team, codebase unit, indexer, API key attribution, agent, status, and start time.
- `review_gate`: workflow review gate truth with run, gate type, status, decision time, and evidence reference.
- `source_custody_policy`: workspace or repository policy state.
- `billing_configuration`: workspace billing plan and account reference.
- `index_snapshot`: snapshot identity, repository, indexer, commit SHA, index hash, source hashes, freshness metadata, ingestion health, and graph metadata reference.
- `graph_metadata`: graph identity, snapshot reference, deterministic flag, node/edge counts, metadata, and object reference. Deterministic graph metadata is authoritative; LLM enrichment belongs elsewhere as lower-authority discovery metadata.
- `context_pack_metadata`: context-pack identity, workspace, repository, run or pull request association, target, anchors, citations, inclusion reasons, exclusion reasons, token budgets, quality metrics, source hashes, content hash, optional bounded snippets, optional object-storage artifact reference, and bounded metadata.
- `artifact_reference`: object-storage reference for large `log`, `transcript`, `evidence_bundle`, `screenshot`, `index_snapshot`, or `context_pack` artifacts. The reference carries workspace, repository, URI, content hash, size, content type, and bounded metadata. Run artifacts also carry `run_id`, index snapshot artifacts carry `snapshot_id`, and context-pack artifacts carry `context_pack_id`.
- `run_event`: run timeline event metadata.
- `cost_event`: provider/model cost metadata with optional team, API key, and repository attribution for cost allocation.
- `audit_event`: actor, action, provider call, redaction, context inclusion/exclusion, and policy decision metadata.
- `failure_event`: run failure type, severity, phase, message, and related metadata.
- `command_event`: command execution metadata, including command text, exit code, phase, severity, and timestamp.
- `context_event`: context inclusion/exclusion metadata, including context-pack reference, decision, phase, severity, and timestamp.

## Field Categories

Metadata fields include workspace display names, team names, API key scopes and actors, repository names, codebase unit names and kinds, indexer health, run status, review gate status, source custody modes, billing plans, index snapshot freshness and ingestion health, graph determinism and counts, context-pack targets, anchor reasons, inclusion and exclusion reasons, token budgets, quality metrics, artifact kinds, artifact sizes, artifact content types, run event types, phases, severities, agents, timestamps, cost provider/model/amount values, audit actions or decisions, audit provider-call/redaction/context/policy metadata, failure metadata, command metadata, and context event decisions.

Hash fields include API key hashes, commit SHAs, repository, index snapshot, and context-pack source hashes, index snapshot index hashes, context-pack content hashes, anchor and citation source hashes, artifact content hashes, and bounded snippet content hashes.

Reference fields include workspace IDs, team IDs, API key IDs, repository IDs, codebase unit IDs, indexer IDs, run IDs, pull request IDs, event IDs, review gate IDs, billing account references, repository remote URLs, index snapshot IDs, index snapshot repository/indexer references, graph IDs, graph snapshot references, graph metadata references, graph object references, context-pack IDs, context-pack anchor/citation/item references, context-pack artifact references, artifact IDs, artifact object URIs, artifact run/context-pack/snapshot associations, context-pack citations, and review gate evidence references.

Dashboard timeline filters are backed by normalized append-only telemetry records with workspace ID, repository ID, run ID, agent, phase, event type, severity, and occurred-at timestamp fields where applicable. Time range filtering uses inclusive ISO 8601 timestamp bounds in this prototype.

Bounded snippet fields include snippet path, citation, start line, end line, content, and content hash. Snippet content must be cited, line-bounded, and within the policy's maximum size.

Forbidden full-source and artifact-body fields include `repository.full_source`, complete source files, source archives, raw file contents outside bounded snippets, full-source or snippet-like fields inside snapshot and graph metadata, and large inline artifact bodies in metadata fields such as logs, transcripts, screenshots, evidence bundles, snapshots, or context-pack payloads. Inline artifact body values over 4096 characters must be represented by an `artifact_reference` payload.
