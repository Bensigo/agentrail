# Server Ingestion Contract

AgentRail server ingestion is metadata-first. The local indexer or runner may submit workspace, team, API key auth metadata, repository, codebase unit, indexer, run, review gate, source custody policy, billing configuration, index snapshot, graph metadata, context-pack metadata, run event, cost event, and audit event records without uploading full source code.

The first contract is represented by `agentrail.server.ingestion` and is intentionally a service-domain prototype, not a production HTTP API or storage writer.

## Storage Routing

Product/auth and workflow truth records use `InMemoryProductAuthStore`, the local prototype stand-in for Postgres product state. This includes workspaces, teams, API key auth metadata, repositories, codebase units, indexers, runs, review gates, source custody policies, and billing configuration.

Append-only telemetry and artifact metadata use `InMemoryTelemetryStore`, the local prototype stand-in for ClickHouse-style event or analytics state. This includes index snapshots, graph metadata, context-pack metadata, run events, cost events, audit events, failure events, command events, and context events.

Tests must prove product/auth writes do not call the telemetry store path.

## Source Custody Policy

Default policy:

```json
{
  "mode": "metadata_only",
  "allow_bounded_snippets": false,
  "max_snippet_chars": 0
}
```

Full source content is forbidden by this contract. Bounded cited snippets may be accepted only when Source Custody Policy explicitly sets `allow_bounded_snippets` and a nonzero `max_snippet_chars`.

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
- `index_snapshot`: indexed commit SHA, source hashes, freshness metadata, ingestion health, and graph metadata reference.
- `graph_metadata`: graph identity, snapshot reference, deterministic flag, node/edge counts, metadata, and object reference.
- `context_pack_metadata`: context-pack identity, target, citations, content hash, artifact reference, and metadata.
- `run_event`: run timeline event metadata.
- `cost_event`: provider/model cost metadata.
- `audit_event`: actor, action, provider call, redaction, context inclusion/exclusion, and policy decision metadata.
- `failure_event`: run failure type, severity, phase, message, and related metadata.
- `command_event`: command execution metadata, including command text, exit code, phase, severity, and timestamp.
- `context_event`: context inclusion/exclusion metadata, including context-pack reference, decision, phase, severity, and timestamp.

## Field Categories

Metadata fields include workspace display names, team names, API key scopes and actors, repository names, codebase unit names and kinds, indexer health, run status, review gate status, source custody modes, billing plans, graph counts, run event types, phases, severities, agents, timestamps, cost provider/model values, audit actions or decisions, audit provider-call/redaction/context/policy metadata, failure metadata, command metadata, and context event decisions.

Hash fields include API key hashes, commit SHAs, repository and index snapshot source hashes, context-pack content hashes, and bounded snippet content hashes.

Reference fields include workspace IDs, team IDs, API key IDs, repository IDs, codebase unit IDs, indexer IDs, run IDs, event IDs, review gate IDs, billing account references, repository remote URLs, graph metadata references, graph object references, context-pack artifact references, context-pack citations, and review gate evidence references.

Dashboard timeline filters are backed by normalized append-only telemetry records with workspace ID, repository ID, run ID, agent, phase, event type, severity, and occurred-at timestamp fields where applicable. Time range filtering uses inclusive ISO 8601 timestamp bounds in this prototype.

Bounded snippet fields include snippet path, citation, start line, end line, content, and content hash. Snippet content must be cited, line-bounded, and within the policy's maximum size.

Forbidden full-source fields include `repository.full_source`, complete source files, source archives, and raw file contents outside bounded snippets.
