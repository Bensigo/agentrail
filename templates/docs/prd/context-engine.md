# Context Engine PRD

## Goal

AgentRail should give coding agents a task-specific context pack before they plan, implement, verify, review, or resume work. The context pack must identify the smallest useful set of repo facts, docs, memory, state, prior mistakes, goals, tools, and exclusions needed for the current task.

The business outcome is fewer repeated agent mistakes, less manual context gathering, and PRs that are easier to audit because the agent can show which sources shaped the work.

## Users

- Maintainers who need to review agent work without reconstructing the agent's discovery path.
- Coding agents running through `agentrail run`, `agentrail prompt`, review, or AFK workflows.
- Small teams that want local, inspectable context management without adopting a black-box SaaS memory layer.

## Non-Goals

- Ingesting Slack, Jira, Confluence, Google Drive, or other organization-wide sources in v1.
- Sending repository content to embedding providers by default.
- Replacing `CONTEXT.md`, GitHub issues, PRDs, milestones, or project memory as source-of-truth artifacts.
- Giving external agent providers unrestricted filesystem authority.
- Using customer data to train models on behalf of AgentRail.

## Product Constraints

- Local-first is the default. Indexing, keyword search, source inventory, redaction, audit logs, and context pack generation must work without external APIs.
- Provider-backed embeddings and summaries are opt-in and must run after allow/deny checks and redaction.
- Every included and excluded source must have a reason and citation.
- Important workflow state must stay visible in `.agentrail/state.json`, run metadata, generated pack files, and PR evidence.
- The first implementation should favor a narrow, inspectable workflow over broad configuration.

## External Research Notes

- Anthropic's context engineering guidance frames context as a finite resource and recommends tight, high-signal context rather than dumping everything into the model.
- Anthropic's contextual retrieval writeup supports combining lexical retrieval, semantic retrieval, contextual chunk metadata, and reranking when the corpus is too large for direct inclusion.
- OpenAI's retrieval documentation describes ranking controls for balancing embedding similarity and text overlap in hybrid search.
- Unblocked's MCP docs show a provider-facing pattern where agents request organizational context through narrow tools such as `context_research` and receive cited answers. AgentRail should follow the narrow-tool pattern, but keep v1 local-first and repo-scoped.

Sources observed on 2026-06-04:

- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/contextual-retrieval
- https://developers.openai.com/api/docs/guides/retrieval
- https://docs.getunblocked.com/unblocked-mcp/mcp-overview
- https://getunblocked.com/

## Required Workflows

### Source Inventory

`agentrail context sources --target .` lists indexable sources in deterministic order before any index, embedding, or context pack step runs.

The inventory covers:

- repo files that are not ignored, binary, oversized, denied, generated, or under skipped directories such as `.git`, `node_modules`, build outputs, and package caches
- `CONTEXT.md`
- `TASTE.md`
- `docs/agents/`
- `docs/memory/`
- `docs/prd/`
- `docs/milestones/`
- `.agentrail/state.json`
- AgentRail run artifacts such as verifier findings and blocked-run reasons
- bundled skill metadata
- later external source descriptors, but not external ingestion content in v1

### Local Index

`agentrail context index --target .` builds and refreshes `.agentrail/context/index/`.

Each source record includes:

- `id`
- `sourceType`
- `path`
- `contentHash`
- `modifiedAt`
- `freshness`
- `authority`
- `visibility`
- `linkedIssues`
- `linkedPullRequests`
- `chunkIds`
- `auditRef`

### Embedding Index

`agentrail context embed --target .` refreshes the local index first, then embeds eligible redacted chunks only when `context.embedding.mode` is explicitly configured to a non-disabled provider mode.

Embedding modes:

- `disabled`
- `openai-compatible`
- `custom-command`
- future provider extension through the same `context.embedding` config object

Embedding records include provider, model, dimension, content hash, chunk ID, text hash, timestamp, and audit reference. Provider failures are recorded in audit events and must not prevent local keyword/BM25 context retrieval.

### Retrieval Query

`agentrail context query "<task>" --target .` returns ranked cited sources using this hybrid model:

1. deterministic required context from issue body, linked PRD, milestone, active state, and explicit `Required context`
2. keyword/BM25 retrieval for exact identifiers, filenames, labels, symbols, issue numbers, command names, and error text
3. embedding retrieval only when an embedding provider is configured
4. source authority and metadata boosts for current workflow state, high-authority docs, same-issue failures, and linked issues or PRs
5. stale, denied, expired, low-authority, and unrelated-source demotion
6. just-in-time file, doc, and tool pointers instead of exhaustive source dumping

The query output includes score breakdowns and inclusion reasons.

### Context Pack Build

`agentrail context build issue <number> --phase plan|execute|verify` writes JSON and Markdown packs under `.agentrail/context/packs/`.

`agentrail context build pr <number> --phase review` writes review-specific packs.

Each pack includes:

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

### Prompt, Run, Review, And Resume Integration

- `agentrail prompt issue <number>` builds or loads the issue context pack and includes a concise summary.
- `agentrail run issue <number>` records `contextPackFile` in run and phase metadata.
- `agentrail prompt review <number>` builds or loads a review context pack.
- `agentrail resume` points to the latest active context pack when one exists.

### Provider Interface

Agent providers should receive narrow JSON-first commands before an MCP server exists:

- `agentrail context query "<task>" --json`
- `agentrail context build issue <number> --phase <phase> --json`
- `agentrail context show <pack-id-or-file> --json`
- `agentrail context explain <pack-id-or-file> --json`

Provider-facing JSON includes stable command metadata (`schemaVersion`, `command`, `target`, `provider`, `audit`) and cited result, pack, or explanation fields. This lets agents consume context without parsing human-oriented Markdown or receiving broad filesystem authority.

An MCP-compatible surface may later expose these narrow tools:

- `context_research`: answers one scoped context question from AgentRail-indexed sources and returns citations, score reasons, provider metadata, and exclusions.
- `context_get_sources`: returns source inventory metadata, authority, visibility, freshness, citations, and redaction metadata; it does not dump arbitrary file contents.
- `context_build_pack`: builds or loads one issue, PR review, phase, or resume context pack and returns pack paths, target metadata, provider metadata, and audit citation.
- `context_explain_pack`: explains why a pack included, excluded, boosted, or demoted sources with citations and score metadata.

Those tools must cite sources, return bounded data, and rely on AgentRail allow/deny and redaction controls for enforcement. MCP roots are advisory scoping hints, not a security boundary. Roots may help choose the local target, but they must not bypass include/exclude globs, denied secret-bearing paths, ignored-file handling, file size limits, binary skipping, redaction, or audit logging.

Provider descriptions must avoid claims that AgentRail can read the whole filesystem or ingest organization-wide Slack, Jira, Confluence, Google Drive, or other SaaS content in v1. The v1 provider contract is local-first, repo-scoped, inspectable, and auditable.

## Enterprise Requirements

### Allow/Deny Controls

AgentRail config supports:

- context include globs
- context exclude globs
- maximum file size
- binary skipping
- generated-file skipping
- ignored-file skipping
- secret redaction settings
- embedding mode: `disabled`, `openai-compatible`, `custom-command`, and future provider extension

Denied paths, `.env` files, private keys, credential files, and secret-looking content are excluded or redacted by default.

### Redaction

Redaction runs before content is stored in an index, embedded, summarized, or included in a context pack. Redaction findings are recorded as audit events with source path, detector, action, and timestamp, without storing the raw secret.

### Audit Logs

AgentRail writes audit events for:

- indexed files
- skipped files
- redactions
- generated context packs
- embedding provider calls
- embedding provider failures
- query and pack explain operations

### External Providers

External providers are disabled by default. When enabled, AgentRail records provider, model, dimension, content hash, chunk ID, timestamp, and audit reference. Provider failures must not break local keyword/BM25 retrieval.

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
  "index": {
    "version": "context-index-v1",
    "builtAt": "2026-06-04T05:29:30Z"
  },
  "retrievalBudget": {
    "maxItems": 20,
    "maxTokens": 6000
  },
  "provider": {
    "mode": "disabled",
    "externalCalls": []
  },
  "goal": {
    "summary": "Define AgentRail context engine architecture and enterprise requirements.",
    "citation": "github:issue/72"
  },
  "included": [
    {
      "kind": "required_context",
      "sourceType": "doc",
      "path": "CONTEXT.md",
      "reason": "Issue #72 requires AgentRail to preserve visible, inspectable workflow state.",
      "citation": "CONTEXT.md#product-principles",
      "score": {
        "deterministic": 1,
        "keyword": 0.72,
        "embedding": null,
        "authorityBoost": 0.2,
        "final": 1
      }
    },
    {
      "kind": "agent_doc",
      "sourceType": "doc",
      "path": "docs/agents/issue-tracker.md",
      "reason": "Defines GitHub issue state and blocked issue promotion rules.",
      "citation": "docs/agents/issue-tracker.md#blocked-issues",
      "score": {
        "deterministic": 0.8,
        "keyword": 0.64,
        "embedding": null,
        "authorityBoost": 0.2,
        "final": 0.91
      }
    }
  ],
  "excluded": [
    {
      "sourceType": "path",
      "path": ".env",
      "reason": "Secret-bearing files are denied by default.",
      "citation": ".agentrail/config.json#context.excludeGlobs"
    },
    {
      "sourceType": "path",
      "path": "node_modules/",
      "reason": "Dependency output is skipped by source inventory rules.",
      "citation": "docs/agents/context-engine.md#source-inventory"
    }
  ],
  "openQuestions": [
    {
      "question": "Should external organization sources be modeled as descriptors only in v1?",
      "reason": "Issue #72 explicitly rejects Slack/Jira/Confluence ingestion in v1."
    }
  ]
}
```

## Example `context-pack.md`

```markdown
# Context Pack: Issue #72 Plan

Goal: Define AgentRail context engine architecture and enterprise requirements.

## Included Context

- `CONTEXT.md`: Required because the issue depends on visible, inspectable workflow state.
- `docs/agents/issue-tracker.md`: Required because blocked issue promotion is part of the workflow model.

## Excluded Context

- `.env`: Excluded by default secret-bearing file rules.
- `node_modules/`: Excluded as dependency output.

## Open Questions

- Should external organization sources be descriptors only in v1?
```

## Success Criteria

- Agents receive explicit selected context instead of generic instructions to rediscover everything manually.
- Maintainers can inspect why each source was included or excluded.
- Context packs work without embeddings or external APIs.
- Provider-backed retrieval remains opt-in, auditable, and redacted.
- Later implementation issues can build source inventory, privacy controls, indexing, chunking, embeddings, retrieval, packs, state framing, prior mistake retrieval, provider interfaces, and evaluation in sequence.
