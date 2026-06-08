# Context Compiler and Enterprise Control Plane PRD

## Problem Statement

Enterprise teams want AI coding agents to work on large, messy codebases without noisy context, hidden assumptions, or unauditable decisions. Basic vector retrieval returns semantically similar chunks that miss code relationships, over-include unrelated files, and lets stale context compete with current code. Generic GraphRAG can become a second noise source when graph expansion is unbounded or built from low-trust LLM-inferred relationships.

AgentRail also needs to move beyond a local CLI-only workflow. Teams need a server-side Agent Operations Console that shows what agents are doing across workspaces, repositories, runs, context packs, review gates, failures, memory, API keys, teams, indexing health, and costs. This must not require uploading full source code by default.

## Solution

AgentRail will build a Context Compiler backed by a deterministic Code Graph and a server-first enterprise control plane.

The Context Compiler turns a task, issue, PR, error, or review into the smallest useful Context Pack by extracting anchors, retrieving candidates, expanding a deterministic Code Graph with hop limits, applying authority/freshness/security policy, reranking, packing under a token budget, and emitting citations, reasons, and evaluation metrics.

The AgentRail Server owns enterprise visibility: workspaces, teams, API keys, repositories, codebase units, index snapshots, context packs, runs, failures, review gates, memory metadata, costs, and audit events. Indexing remains local or self-hosted by default. The Local Indexer sends bounded metadata, graph edges, hashes, commit SHAs, run events, cost events, audit events, and context-pack metadata. Bounded cited snippets are uploaded only when workspace policy allows it.

The Agent Operations Console uses dense observability patterns: tables, filters, overview-to-drilldown navigation, timelines, health states, cost views, and evidence surfaces. It is not a vanity dashboard; it exists to answer what happened, why it happened, what context was used, what was excluded, what failed, what it cost, and which gates passed.

## User Stories

1. As an engineering lead, I want agents to receive task-specific context packs, so that they do not waste tokens on unrelated files.
2. As an engineering lead, I want context packs to show citations and inclusion reasons, so that I can audit why an agent touched code.
3. As a reviewer, I want to see excluded context and exclusion reasons, so that I can detect policy, redaction, or stale-context effects.
4. As a reviewer, I want review gates to check verification evidence, so that agents cannot claim work is done without proof.
5. As a maintainer, I want failed runs to become visible evidence, so that repeated mistakes are not rediscovered manually.
6. As a maintainer, I want stale memory to be demoted, so that old lessons do not outrank current code.
7. As a developer, I want the retrieval engine to find tests and dependent files through code relationships, so that I do not rely on keyword or semantic similarity alone.
8. As a developer, I want the graph to prefer deterministic code/test/doc evidence, so that LLM-generated relationships cannot become source truth.
9. As a developer, I want Graph Enrichment to be visibly low authority, so that inferred relationships can help discovery without corrupting retrieval.
10. As an enterprise security owner, I want indexing to run locally or self-hosted by default, so that source code custody stays under workspace control.
11. As an enterprise security owner, I want full source upload disabled by default, so that adopting AgentRail does not create unnecessary source exposure.
12. As an enterprise security owner, I want snippet upload to be policy-controlled, so that each workspace can choose its own custody posture.
13. As a platform admin, I want API keys scoped to workspaces and teams, so that integrations can be managed without broad access.
14. As a platform admin, I want audit events for provider calls, redactions, context inclusion, and policy decisions, so that sensitive actions are inspectable.
15. As a platform admin, I want indexing health per repository, so that stale or failed indexes are obvious.
16. As a platform admin, I want cost events recorded during runs, so that spend can be attributed by workspace, team, repo, API key, and run.
17. As a team lead, I want to switch workspaces in the console, so that I can operate multiple customer or internal environments.
18. As a team lead, I want to see runs across repositories, so that I can understand current agent activity.
19. As a team lead, I want to open a run and inspect its context pack, failures, review gates, and costs, so that I can make operational decisions quickly.
20. As a team lead, I want repeated failure patterns to surface, so that I can improve instructions, tests, review gates, or memory.
21. As a team lead, I want codebase units detected in monorepos and polyrepos, so that unrelated apps, packages, services, or legacy areas are not mixed into context.
22. As a team lead, I want teams and ownership attached to repositories and codebase units, so that failures and costs can be routed to the right people.
23. As a context-engine maintainer, I want retrieval quality gates, so that "not noise" is measured with fixtures instead of asserted.
24. As a context-engine maintainer, I want required-source inclusion to be 100% for fixtures, so that important context misses block production readiness.
25. As a context-engine maintainer, I want citation coverage to be 100%, so that every included result can be traced.
26. As a context-engine maintainer, I want stale or denied source leakage to be zero, so that policy and freshness failures are caught.
27. As a context-engine maintainer, I want graph expansion hop limits, so that graph traversal does not create unbounded context noise.
28. As a context-engine maintainer, I want token budgets to be explicit and configurable, so that the compiler optimizes for small high-signal packs.
29. As an agent provider integrator, I want JSON-first context pack APIs, so that agents can consume context without parsing Markdown.
30. As an enterprise buyer, I want evidence that AgentRail can work across different repo structures, so that adoption does not depend on one monorepo convention.

## Implementation Decisions

- The canonical retrieval product term is Context Compiler. Basic RAG and generic GraphRAG are rejected as product-level descriptions because they obscure the quality bar.
- The Context Compiler pipeline is: task/issue/PR/error/review input, anchor extraction, candidate retrieval, deterministic Code Graph expansion, authority/freshness/security policy, reranking, token packing, citations, reasons, and metrics.
- The authoritative graph is deterministic-first. Parsed code, tests, imports, references, git history, issues, PRs, explicit docs, run evidence, and ownership config outrank LLM-generated relationships.
- Graph Enrichment is allowed only as low-authority discovery help. It must not outrank deterministic evidence.
- Graph traversal starts from strong anchors and has default hop limits. The initial default should be two hops unless retrieval evaluation proves a different limit.
- Codebase Unit is the canonical term for meaningful repo areas such as apps, packages, services, modules, build targets, or legacy folder boundaries.
- Codebase Unit detection should work usefully with zero config and improve with manifests, workspace files, build files, dependency edges, ownership files, import structure, tests, and explicit config.
- The existing context pack contract remains the compatibility foundation. New compiler outputs should extend, not replace, the existing cited pack model.
- The existing local context engine should evolve into or feed the Local Indexer instead of being discarded.
- The Local Indexer is responsible for source inventory, redaction, deterministic graph extraction, hashes, commit SHAs, index snapshots, and context-pack build metadata.
- The AgentRail Server is responsible for workspaces, users, teams, API keys, repositories, codebase units, indexers, index snapshots, graph metadata, context packs, runs, run events, failures, review gates, memory items, cost events, audit events, and source custody policies.
- Default enterprise mode does not upload full source code.
- Bounded cited snippets may be uploaded only when workspace Source Custody Policy allows it.
- The Agent Operations Console is the dashboard product surface. It includes workspace switching, runs, context packs, failures, review gates, costs, repos/indexing health, memory, API keys, and teams.
- The console should use dense observability product patterns: tables, filters, drilldowns, health states, timelines, event detail pages, cost breakdowns, and evidence-first views. See TASTE.md for the full design guide.
- Review gates are policy checkpoints over run evidence, context provenance, verification evidence, failures, and acceptance criteria mapping.
- Cost tracking should use Cost Events emitted during runs, retrieval, embedding, reranking, generation, storage, or provider calls rather than only estimating cost after completion.
- Auditability requires every included and excluded context item to have a citation and reason.
- Server APIs should be event-friendly and append-only where possible for Run Events, Cost Events, and Audit Events.
- Memory remains advisory and must not outrank current code, explicit docs, current task instructions, or same-run evidence.
- Skills are procedural context. Skill selection should be resolved per task/phase and kept separate from source evidence.

## Testing Decisions

- Retrieval tests should validate observable compiler behavior, not internal scoring implementation details.
- Required-source inclusion must be tested with fixtures that include code files, docs, memory, failures, tests, and graph relationships.
- Citation coverage must be 100% for included top results and context-pack sections.
- Stale, denied, redacted, or unrelated sources must not leak into included context.
- Graph expansion tests should include relationship-heavy tasks where basic vector retrieval would miss relevant files.
- Codebase Unit detection should have fixtures for at least one monorepo-style workspace, one simple single-package repo, and one legacy folder structure with weak manifests.
- Source custody tests should verify that default enterprise mode does not upload full source code and that snippet upload depends on policy.
- Server ingestion tests should verify idempotent handling of index snapshots, graph edges, run events, cost events, and audit events.
- Console tests should focus on user-visible flows: workspace switching, run drilldown, context-pack inspection, failure review, review-gate status, cost breakdown, indexing health, API key management, and team management.
- Existing context-engine verification commands remain relevant for local behavior and should be extended as the compiler evolves.

## Out of Scope

- Uploading full source code to the AgentRail Server by default.
- LLM-generated graph edges as authoritative source truth.
- Organization-wide ingestion from Slack, Jira, Confluence, Google Drive, or similar systems in the first enterprise slice.
- A generic analytics dashboard unrelated to agent operations.
- Generic analytics dashboards unrelated to agent operations evidence.
- Building the full Agent Operations Console before the Context Compiler and local deterministic graph index produce trustworthy events.
- Treating memory as permanent truth.
- Supporting every possible language and build system perfectly in the first release.

## Further Notes

- The first milestone should focus on the Context Compiler contract and local deterministic graph index.
- The second milestone should prove retrieval quality with relationship-heavy fixtures and hard quality gates.
- Server ingestion and Agent Operations Console should build on emitted artifacts and events, not parallel state.
- The product thesis is: AgentRail gives AI coding agents the smallest trustworthy context pack for a task, with provenance, deterministic code relationships, review gates, and enterprise auditability.
