# Context Engine

AgentRail context packs are auditable artifacts that tell an agent what matters for a specific issue, PR, phase, or resume operation.

Use context packs to reduce blind repo exploration, prevent repeated verifier mistakes, and make PR review easier. Do not treat context packs as hidden truth. Current code, GitHub issues, PRDs, milestones, `CONTEXT.md`, and explicit user instructions remain more authoritative when they conflict.

## Vocabulary

Use these terms consistently in context-engine docs, code comments, PR evidence, and provider-facing descriptions:

- **Context Compiler**: the local compilation layer that turns a task, issue, PR, review, error, or resume request into bounded context metadata. It emits the additive `compiler` JSON object with anchors, candidates, graph expansion status, policy metadata, rerank metadata, token pack metadata, citations, reasons, metrics, and compatibility mappings.
- **Context Pack**: the target- and phase-specific JSON and Markdown artifact written under `.agentrail/context/packs/`. A pack groups selected evidence, procedural guidance, exclusions, budget limits, provider metadata, audit metadata, and compiler metadata for agent consumption and review.
- **Code Graph**: the future deterministic repo relationship authority for paths, symbols, tests, docs, issues, PRs, and other codebase relationships. Until it exists, compiler `graphExpansion.status` remains `not_available`; when it exists, graph expansion must start from strong anchors and cite deterministic evidence for every added candidate.
- **Codebase Unit**: a stable, repo-scoped object that the Code Graph can cite, such as a file, module, package, route, class, function, symbol, test, config item, generated artifact descriptor, or documentation section. A codebase unit is source-cited and policy-filtered; it is not an unrestricted source dump.
- **Source Custody Policy**: the policy that decides whether AgentRail may expose metadata, snippets, or full source to a provider or server. The default server-first enterprise posture is metadata-only: full source upload is not required, snippet upload is disabled unless policy explicitly allows it, and allow/deny plus redaction checks run before any external provider can receive source text.
- **Retrieval Quality Gate**: the verification gate that checks required-source inclusion, recall, citation coverage, reason coverage, stale or denied leakage, excluded-source handling, and budget metadata before context output is trusted.

## Internal Architecture

Context-engine implementation lives in the typed Python package under `agentrail/context/`. The public `agentrail context ...` CLI is routed through `agentrail/cli/commands/context.py`; `scripts/agentrail` is only the compatibility launcher.

Module boundaries:

- `agentrail/context/sources.py`: source inventory, source typing, authority, freshness, linked issue and PR metadata.
- `agentrail/context/index.py`: local indexing, Markdown/code chunking, audit events, embedding payload manifests.
- `agentrail/context/redaction.py`: secret redaction detectors and redaction finding records.
- `agentrail/context/compiler.py`: Context Compiler contract helpers, anchor extraction, source custody policy metadata, candidates, citations, reasons, metrics, and compatibility mapping.
- `agentrail/context/embeddings.py`: disabled, custom-command, and OpenAI-compatible embedding orchestration.
- `agentrail/context/retrieval.py`: keyword/BM25, deterministic context, embedding blending, score reasons, excluded sources.
- `agentrail/context/packs.py`: issue and PR context pack JSON/Markdown generation.
- `agentrail/context/models.py`: typed dataclasses for source records, chunks, freshness, and redactions.

Future context-engine work should add behavior to these modules and keep JSON serialization explicit at command boundaries. Do not add new embedded `node <<'NODE'` context-engine blocks to shell launchers.

Verification for context-engine changes:

```bash
bash scripts/test-python
npm run typecheck
bash scripts/test-context-sources
bash scripts/test-context-index
bash scripts/test-context-privacy
bash scripts/test-context-embeddings
bash scripts/test-context-query
bash scripts/test-context-packs
bash scripts/test-context-evaluation
```

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

Contextual summaries are optional chunk enrichment. They are disabled by default:

```json
{
  "context": {
    "summary": {
      "mode": "disabled",
      "provider": null,
      "model": null
    }
  }
}
```

Any non-disabled summary mode must name an explicit provider before AgentRail can attempt generation. Local indexing must still produce source-citable chunks with `summary: null` when summaries are disabled.

### Context Pack

A context pack is the phase-specific output consumed by agents and reviewers. It includes:

- goal
- goals relevant to the target and phase
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

## Embeddings

Embeddings are disabled by default. A non-disabled embedding mode never runs during source inventory or local indexing.

Run:

```bash
agentrail context embed --target .
```

The command first refreshes the local context index, so source allow/deny rules, ignored-file handling, file size limits, binary skipping, and redaction run before any provider receives chunk text.

Supported embedding modes:

- `disabled`: local-only mode; no provider call is made.
- `openai-compatible`: sends redacted chunk text to a configured OpenAI-compatible `/embeddings` endpoint.
- `custom-command`: sends each redacted chunk payload to a local command over stdin and reads a JSON embedding result from stdout.
- Future modes may extend `context.embedding` without changing the local index contract.

Embedding metadata is written under `.agentrail/context/index/embeddings.json` and records provider, model, dimension, content hash, chunk ID, text hash, timestamp, and audit reference. Failed provider calls are audit events and must not break local keyword/BM25 retrieval.

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

## Goals

Context packs include goal records from `.agentrail/state.json` only when they are relevant to the current target:

- Issue packs include active or blocked goals whose `activeIssue` matches the issue number.
- PR review packs include active or blocked goals whose `activePullRequest` matches the PR number.
- Completed unrelated goals are omitted.
- Unrelated active goals are omitted even if they appear in `.agentrail/state.json`.

The singular `goal` field remains as compatibility framing. When a relevant goal exists, it uses that goal's summary and cites `.agentrail/state.json#workflow.goals`; otherwise it falls back to generated context-pack framing for the target.

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

Every JSON response intended for provider consumption includes:

- `schemaVersion`
- `command`
- `target`
- `generatedAt` when the command creates or loads time-bound context
- `provider`
- `audit`
- cited result, section, or path fields

Agents should treat this JSON as a context contract, not as hidden truth. Current source files, GitHub issues, PRDs, ADRs, `CONTEXT.md`, and explicit user instructions remain more authoritative when they conflict.

## Context Compiler Contract

The stable compiler contract is documented in `docs/agents/context-compiler-contract.md`.

Compiler data appears under a `compiler` object on provider-facing JSON when available. Existing top-level fields remain the backward-compatible surface for older consumers. New consumers should prefer `compiler` and fall back to legacy fields when `compiler` is absent.

Every `context-compiler-v1` object includes:

- `anchors`
- `candidates`
- `graphExpansion`
- `policy`
- `rerank`
- `tokenPack`
- `citations`
- `reasons`
- `metrics`
- `compatibility`

Compiler sections map to the current query and build JSON without removing legacy fields:

| Compiler Section | Current Query/Build Source |
|---|---|
| `input` | The query string or generated context-pack query for `agentrail context build ...`. |
| `anchors` | Deterministic handles extracted from the request, issue target, PR target, paths, commands, symbols, tests, and error text. |
| `candidates[kind=source_evidence]` | Query `results`, pack `included`, and pack sections such as `requiredContext`, `likelyFiles`, `likelyDocs`, `relevantMemory`, `priorMistakes`, `activeState`, and `goals`. |
| `candidates[kind=procedural_guidance]` | Pack `availableTools` and `availableSkills`. Selected skills are workflow guidance, not source evidence. |
| `candidates[kind=excluded_context]` | Query `excluded`, pack `excludedContext`, and denied, stale, redacted, unavailable, or budget-omitted context metadata. |
| `graphExpansion` | Currently `not_available`; future Code Graph expansion metadata must cite deterministic graph evidence. |
| `policy` | Source custody, redaction, denied-source handling, authority order, and freshness order derived from local context config and source metadata. |
| `rerank` | Current score-sorted selected and rejected candidate IDs. Provider reranking may add model/audit metadata later. |
| `tokenPack` | Current `retrievalBudget`, selected candidate IDs, omitted candidate IDs, token estimate when available, and packing strategy. |
| `citations` and `reasons` | Coverage summaries over every included and excluded candidate exposed to agents. |
| `metrics` | Candidate counts, selected counts, excluded counts, citation coverage, reason coverage, and stale or denied leakage. |
| `compatibility` | Explicit mappings from legacy query/build/pack fields to compiler fields. |

`candidates` distinguish `source_evidence`, `procedural_guidance`, and `excluded_context`. Source evidence can justify implementation and review decisions. Skills, tools, and review gates are procedural guidance only; they do not prove source behavior.

Every included and excluded item exposed to an agent must have both a citation and a reason. Missing citation or reason coverage is a retrieval quality failure, not a formatting preference.

Default policy is metadata-only source custody, snippet upload disabled unless policy explicitly allows it, redaction enabled, denied sources excluded from included context, and explicit authority/freshness policy effects on candidates when available. Full source upload is not required for the server-first enterprise model; server ingestion can rely on source IDs, hashes, citations, reasons, policy metadata, and audit references unless a stricter policy explicitly permits more.

## MCP-Compatible Provider Tools

The later MCP surface should expose narrow tools that map directly to the CLI commands. These tools do not grant general filesystem access.

| Tool | Equivalent CLI | Purpose | Bounded Output |
|---|---|---|---|
| `context_research` | `agentrail context query "<task>" --json` | Answer one scoped context question from indexed AgentRail sources. | Ranked cited sources, reasons, score breakdown, provider metadata, and excluded-source metadata. |
| `context_get_sources` | `agentrail context sources --target .` | Return source inventory metadata for an allowed target. | Source IDs, source types, paths or descriptor URIs, freshness, authority, visibility, citations, and redaction metadata. No unrestricted file dumps. |
| `context_build_pack` | `agentrail context build issue <number> --phase <phase> --json` or `agentrail context build pr <number> --phase review --json` | Build or load an auditable context pack for one issue, PR review, phase, or resume operation. | Pack ID, target, generated paths, retrieval budget, provider metadata, and audit citation. |
| `context_explain_pack` | `agentrail context explain <pack-id-or-file> --json` | Explain why a context pack included, excluded, boosted, or demoted sources. | Section counts, cited reasons, score metadata, provider metadata, and audit citation. |

Tool descriptions must cite their source set and state their limits. A valid description says the tool can inspect AgentRail-indexed, allowed, redacted sources and return cited context. It must not say the tool can read arbitrary files, crawl the repository, access hidden user data, or ingest organization-wide Slack, Jira, Confluence, or Google Drive content in v1.

MCP roots are advisory scoping hints only. AgentRail access enforcement comes from the local context configuration: include globs, exclude globs, ignored-file handling, binary skipping, maximum file size, denied secret-bearing paths, redaction detectors, and audit logging. A provider may pass roots to help AgentRail choose a target, but roots do not override AgentRail allow/deny or redaction decisions.

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
- reason coverage
- stale or denied leakage from compiler policy metadata
- compiler budget metadata presence

Existing fixture fields remain compatible. Compiler-aware evaluation adds metrics to the report; it does not require migrating existing fixture JSON.

Run fixture evaluation with:

```bash
agentrail context evaluate docs/agents/context-retrieval-fixtures.json --target . --json
```

A fixture file is JSON with a top-level `fixtures` array:

```json
{
  "schemaVersion": 1,
  "fixtures": [
    {
      "name": "issue-84-local-quality",
      "task": "issue #84 retrieval quality evaluation recall@5 recall@10",
      "requiredSources": ["docs/agents/issue-84.md", "src/retrieval_eval.py"],
      "expectedFiles": ["src/retrieval_eval.py"],
      "expectedDocs": ["docs/agents/issue-84.md"],
      "expectedMemory": ["docs/memory/retrieval-evaluation.md"],
      "expectedPriorMistakes": [".agentrail/runs/issue-84-retry/findings.json"],
      "expectedExcludedSources": [".env", "external://denied-eval"]
    }
  ]
}
```

`requiredSources` are hard requirements. If omitted, AgentRail treats expected files, docs, memory, and prior mistakes as required. `expectedExcludedSources` are hard exclusions; these are normally stale, denied, expired, secret-bearing, or otherwise off-limits sources.

To add a fixture:

1. Add local repo content for the behavior under test.
2. Write task text that matches the real agent request.
3. Fill every expected source bucket, using an empty array when a bucket does not apply.
4. Put denied, stale, expired, or secret-bearing sources in `expectedExcludedSources`.
5. Run `agentrail context evaluate <fixture-file> --target . --json`.
6. Add the fixture command or script to CI when it protects a business-critical path or failure-prone retrieval edge.

CI must fail when required context is missed, denied or stale sources appear in included results, top results lack citations or reasons, or compiler outputs omit explicit budget metadata. Embedding-backed evaluation fixtures should set `optionalProviderEnv`, for example `["OPENAI_API_KEY"]` or a local mock provider env. AgentRail skips those fixtures unless every listed provider environment variable is configured.
