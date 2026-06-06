# Server Ingestion Contract

AgentRail server ingestion is metadata-first. The local indexer or runner may submit workspace, repository, index snapshot, graph metadata, context-pack metadata, run event, cost event, and audit event records without uploading full source code.

The first contract is represented by `agentrail.server.ingestion` and is intentionally a service-domain prototype, not a production HTTP API or storage writer.

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
- `repository`: repository identity, remote reference, commit SHA, source hashes, and optional bounded snippets.
- `index_snapshot`: indexed commit SHA, source hashes, freshness metadata, ingestion health, and graph metadata reference.
- `graph_metadata`: graph identity, snapshot reference, deterministic flag, node/edge counts, metadata, and object reference.
- `context_pack_metadata`: context-pack identity, target, citations, content hash, artifact reference, and metadata.
- `run_event`: run timeline event metadata.
- `cost_event`: provider/model cost metadata.
- `audit_event`: actor, action, policy decision, and audit metadata.

## Field Categories

Metadata fields include workspace display names, repository names, graph counts, run event types, phases, severities, cost provider/model values, and audit actions or decisions.

Hash fields include commit SHAs, repository and index snapshot source hashes, context-pack content hashes, and bounded snippet content hashes.

Reference fields include repository remote URLs, graph metadata references, graph object references, context-pack artifact references, and context-pack citations.

Bounded snippet fields include snippet path, citation, start line, end line, content, and content hash. Snippet content must be cited, line-bounded, and within the policy's maximum size.

Forbidden full-source fields include `repository.full_source`, complete source files, source archives, and raw file contents outside bounded snippets.
