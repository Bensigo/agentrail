# ADR 0006: Full AgentRail Repository Architecture

## Status

Accepted

## Context

AgentRail is no longer only a local CLI and context engine. It now includes local agent execution, context compilation, deterministic code graph indexing, server ingestion, product/auth state, high-volume telemetry, object-storage artifact references, and a future Agent Operations Console.

Without a repository architecture decision, agents will guess where to place code. That creates mixed responsibilities, duplicated schemas, dashboard logic inside route files, telemetry stored in product tables, and local runner code coupled to server implementation details.

## Decision

AgentRail will use a repo architecture with clear boundaries:

```text
agentrail/
  cli/
    commands/
  local/
    runner/
    state/
    worktrees/
    afk/
  context/
    compiler/
    indexer/
    graph/
    retrieval/
    packs/
    evaluation/
    redaction/
  server/
    ingestion/
    product/
    telemetry/
    auth/
    billing/
    policies/
    read_models/
  shared/
    ids/
    json/
    git/
    fs/
    validation/

apps/
  console/
    app/
    components/
    lib/
    public/

packages/
  contracts/
  db-postgres/
  db-clickhouse/
  storage/
  auth/
  ui/

templates/
skills/
docs/
milestones/
tests/
scripts/
```

Current Python modules may stay flat while slices are small, but new implementation work should move toward these ownership boundaries instead of growing broad files.

## Ownership Boundaries

- `agentrail/cli`: command parsing, CLI output, and delegation only. No business logic that cannot be called without a shell.
- `agentrail/local`: local runner orchestration, durable state, Ralph issue execution, AFK queue, worktree management, run evidence capture, and ingestion client emission.
- `agentrail/context`: Context Compiler, local source inventory, deterministic Code Graph, retrieval, context packs, redaction, embeddings, and quality evaluation.
- `agentrail/server/ingestion`: validation, source custody enforcement, idempotency, storage routing, and ingestion contracts.
- `agentrail/server/product`: product/auth workflow truth that belongs in Postgres.
- `agentrail/server/telemetry`: append-only run, cost, audit, failure, command, context, snapshot, graph, and artifact telemetry that belongs in ClickHouse or object metadata tables.
- `agentrail/server/read_models`: dashboard query composition over product/auth data, telemetry, and artifact references.
- `agentrail/shared`: small dependency-light helpers and shared primitives. No feature policy or product workflow logic.
- `apps/console`: Next.js App Router dashboard. It consumes read models and APIs; it does not own ingestion policy, telemetry schemas, or local runner behavior.
- `packages/contracts`: shared schemas and typed contracts used by CLI/local, server, and console.
- `packages/db-postgres`: migrations/schema/client helpers for product/auth state.
- `packages/db-clickhouse`: migrations/schema/client helpers for telemetry queries.
- `packages/storage`: object-storage artifact reference helpers and signed access paths.
- `packages/auth`: Auth.js/NextAuth configuration, adapters, session helpers, workspace membership, and RBAC helpers.
- `packages/ui`: shared shadcn/ui wrappers only when reuse across console surfaces justifies it.

## Data Flow

```text
local runner
  -> context compiler / code graph / context pack
  -> ingestion client
  -> server ingestion
  -> Postgres product/auth state
  -> ClickHouse telemetry
  -> object storage artifacts
  -> read models
  -> Next.js console
```

## Import Rules

- CLI may call local, context, server contract helpers, and shared helpers.
- Local runner may call context, contracts, ingestion client helpers, and shared helpers.
- Context code must not import console code or concrete dashboard read models.
- Server ingestion may depend on contracts, product, telemetry, policies, and shared helpers.
- Server read models may compose product, telemetry, storage, auth, and contracts.
- Console may call server APIs/read models and shared UI/client helpers, but must not duplicate ingestion validation or source custody policy.
- Shared helpers must not import feature modules.

## Storage Rules

- Postgres stores product/auth truth: users, accounts, sessions, workspaces, teams, memberships, API keys, repositories, codebase units, indexers, runs, review gates, source custody policies, and billing configuration.
- ClickHouse stores high-volume append-only telemetry: run events, cost events, audit events, failure events, command events, context events, index snapshot metadata, graph metadata, and context-pack metadata.
- Object storage stores large artifacts: transcripts, logs, screenshots, evidence bundles, context-pack artifacts, index snapshots, and graph blobs.
- Large artifact bodies must not be stored inline in product rows.

## Testing Layout

Tests follow ownership:

```text
tests/
  cli/
  local/
  context/
  server/
  console/
  contracts/
  integration/
```

Context tests prove compiler/index/retrieval behavior. Server tests prove ingestion policy, idempotency, storage routing, auth rules, and read models. Console tests prove visible flows and authorization boundaries. Integration tests prove local runner to ingestion to dashboard timeline flow.

## Consequences

This structure gives agents a map before they create files. It keeps local execution, context intelligence, server ingestion, telemetry, auth, storage, and dashboard UI from collapsing into one mixed layer.

It adds more directories than a small CLI-only tool needs, but AgentRail is becoming a local-plus-server product. The boundary cost is lower than cleaning up guessed architecture later.

## Non-Goals

- Do not move all current files in one refactor just to match this ADR.
- Do not build console UI before ingestion/read models can provide real evidence.
- Do not store source code or large artifacts in Postgres by default.
- Do not let dashboard route files own business rules or ingestion policy.
