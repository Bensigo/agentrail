# Context Engine

AgentRail context packs are auditable artifacts that tell an agent what matters for a specific issue, PR, phase, or resume operation.

Use context packs to reduce blind repo exploration, prevent repeated verifier mistakes, and make PR review easier. Do not treat context packs as hidden truth. Current code, GitHub issues, PRDs, milestones, `CONTEXT.md`, and explicit user instructions remain more authoritative when they conflict.

## Core Objects

### Source Record

A source record describes one indexable item before chunking or retrieval:

```json
{
  "id": "source:docs/agents/issue-tracker.md",
  "sourceType": "agent_doc",
  "path": "docs/agents/issue-tracker.md",
  "contentHash": "sha256:...",
  "modifiedAt": "2026-06-04T05:00:00Z",
  "freshness": {
    "status": "current",
    "observedAt": "2026-06-04T05:00:00Z",
    "expiresAt": null
  },
  "authority": "high",
  "visibility": "local",
  "linkedIssues": [],
  "linkedPullRequests": [],
  "chunkIds": ["chunk:docs/agents/issue-tracker.md#blocked-issues"],
  "auditRef": "audit:20260604T050000Z:docs-agents-issue-tracker"
}
```

Required fields:

- `id`: stable local identifier.
- `sourceType`: one of `code`, `context_doc`, `taste_doc`, `agent_doc`, `memory`, `prd`, `milestone`, `agentrail_state`, `run_artifact`, `skill`, or `external_descriptor`.
- `path`: repo-relative path or external descriptor URI.
- `contentHash`: SHA-256 of stored, redacted content when content is stored.
- `freshness`: current, stale, expired, or unknown.
- `authority`: critical, high, normal, low, or denied.
- `visibility`: local, redacted, denied, external-opt-in, or metadata-only.
- `linkedIssues`, `linkedPullRequests`, and `chunkIds`: relationship metadata.

### Chunk Record

A chunk record is the retrievable unit:

```json
{
  "id": "chunk:docs/agents/issue-tracker.md#blocked-issues",
  "sourceId": "source:docs/agents/issue-tracker.md",
  "path": "docs/agents/issue-tracker.md",
  "headingPath": ["Issue Tracker", "Blocked Issues"],
  "language": "markdown",
  "symbolHints": [],
  "textHash": "sha256:...",
  "summary": null,
  "citation": "docs/agents/issue-tracker.md#blocked-issues"
}
```

Markdown docs are chunked by headings with parent heading metadata. Code files are chunked into stable sections with file path, language, and cheap symbol or import hints when available. Memory entries retain `kind`, `source`, `confidence`, `created_at`, and `expires_at`.

### Context Pack

A context pack is the phase-specific output consumed by agents and reviewers. It includes:

- goal
- required context
- likely files
- likely docs
- relevant memory
- prior mistakes
- active state
- available tools and skills
- excluded context
- open questions
- retrieval budget
- generated timestamp
- index version
- provider and audit metadata

## Source Inventory

Run:

```bash
agentrail context sources --target .
```

The command lists source records in deterministic order. It excludes:

- `.git/`
- `node_modules/`
- build outputs
- package manager caches
- binary files
- ignored files
- files over the configured maximum size
- denied paths
- secret-bearing files such as `.env`, private keys, and credentials

The inventory includes optional docs only when present. Missing `docs/memory/`, `docs/prd/`, or `docs/milestones/` should not fail the command.

## Ranking Rules

AgentRail uses a hybrid retrieval model:

1. Include deterministic required context first: issue body links, `Required context`, active state, linked PRD, linked milestone, and same-issue verifier findings.
2. Add keyword/BM25 matches for exact identifiers, paths, issue numbers, PR numbers, symbols, labels, command names, and error text.
3. Add embedding matches only when an embedding provider is explicitly configured.
4. Blend lexical and semantic ranks with reciprocal rank fusion when both are available.
5. Boost high-authority docs, current workflow state, same-issue prior failures, linked issues, linked PRs, and exact path matches.
6. Demote stale memory, expired memory, low-authority matches, unrelated prior mistakes, and sources outside the current target.
7. Exclude denied sources. Denied sources may appear only in `excludedContext` with a reason and citation, never as content.

Every result must expose a score breakdown and inclusion reason.

## Required Context

Required context comes from:

- GitHub issue `## Required context`
- linked PRDs and milestones
- `CONTEXT.md`
- `TASTE.md` when it affects the workflow or quality bar
- active run, issue, PR, milestone, or goal in `.agentrail/state.json`
- verifier findings for the same issue when retrying

Required context should be included even when keyword or embedding scores are weak. If a required source is denied, missing, or redacted, the pack must list it under open questions or excluded context.

## Prior Mistakes

Prior mistakes may come from:

- verifier `findings.json`
- blocked run reasons
- review-fix issues
- memory-suggestion issues
- `docs/memory/failure-patterns.md`

Each prior mistake must include:

- source
- why it matters
- prevention guidance

Resolved or stale mistakes are demoted unless they belong to the same issue or active run.

## Provider-Facing Commands

Provider-facing output should be JSON-first and bounded:

```bash
agentrail context query "<task>" --target . --json
agentrail context build issue 72 --phase plan --target . --json
agentrail context build pr 9 --phase review --target . --json
agentrail context show .agentrail/context/packs/issue-72-plan.json --json
agentrail context explain .agentrail/context/packs/issue-72-plan.json --json
```

The later MCP-compatible surface should expose narrow tools:

- `context_research`: answer a scoped context question with citations from indexed sources.
- `context_get_sources`: return source metadata and citations without dumping unrestricted file content.
- `context_build_pack`: build or load a context pack for an issue, PR, phase, or resume operation.
- `context_explain_pack`: explain why a pack included, excluded, boosted, or demoted sources.

Tool descriptions must cite sources, describe limits, and avoid granting unrestricted filesystem authority. MCP roots are advisory. AgentRail allow/deny rules, redaction, and audit controls enforce source access.

## Example `context-pack.json`

```json
{
  "schemaVersion": 1,
  "packId": "issue-72-plan-20260604T053000Z",
  "target": {
    "kind": "issue",
    "number": 72,
    "phase": "plan"
  },
  "generatedAt": "2026-06-04T05:30:00Z",
  "retrievalBudget": {
    "maxItems": 20,
    "maxTokens": 6000
  },
  "provider": {
    "mode": "disabled",
    "externalCalls": []
  },
  "included": [
    {
      "kind": "required_context",
      "path": "CONTEXT.md",
      "reason": "Defines visible state and inspectable workflow constraints.",
      "citation": "CONTEXT.md#product-principles",
      "score": {
        "deterministic": 1,
        "keyword": 0.72,
        "embedding": null,
        "authorityBoost": 0.2,
        "final": 1
      }
    }
  ],
  "excluded": [
    {
      "path": ".env",
      "reason": "Secret-bearing files are denied by default.",
      "citation": ".agentrail/config.json#context.excludeGlobs"
    }
  ],
  "openQuestions": []
}
```

## Example `context-pack.md`

```markdown
# Context Pack: Issue #72 Plan

Goal: Define AgentRail context engine architecture and enterprise requirements.

## Included Context

- `CONTEXT.md`: Defines visible state and inspectable workflow constraints.

## Excluded Context

- `.env`: Secret-bearing files are denied by default.

## Open Questions

None.
```

## Agent Consumption Rules

- Read the pack summary before planning or editing.
- Open cited sources when a decision depends on details.
- Treat excluded context as unavailable. Do not work around denied sources.
- If required context is missing, denied, stale, or contradictory, stop and surface the blocker.
- Cite the pack and the underlying source files in PR evidence when the pack shaped implementation.
- Do not claim acceptance criteria are complete unless verification evidence maps back to the issue.

## Evaluation

Retrieval quality tests should use local fixtures with:

- task text
- expected files
- expected docs
- expected memory
- expected prior mistakes
- expected excluded sources

Reports should include:

- required-source inclusion
- recall@5
- recall@10
- stale-source exclusion
- citation coverage

CI must fail when required context is missed or denied sources appear in results. Embedding-backed evaluation runs only when provider environment variables are configured.
