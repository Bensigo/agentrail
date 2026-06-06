# Milestone 004: Server Ingestion Spine

## Source PRD

docs/prd/context-compiler-enterprise-control-plane.md

## Outcome

The AgentRail Server can receive the evidence needed for enterprise visibility without full source upload: index snapshots, graph metadata, context-pack metadata, run events, cost events, audit events, and source custody policy state.

## Users

- Enterprise security owner
- Platform admin
- Team lead operating AgentRail across repositories

## Vertical Scope

This milestone may touch:

- API/routes: ingestion endpoints or command contract for index snapshots, graph metadata, context-pack metadata, run events, cost events, and audit events.
- Domain logic: source custody policy enforcement and idempotent event ingestion.
- Data/storage: Postgres-backed product/auth model for workspaces, teams, users, API keys, repositories, codebase units, indexers, runs, review gates, policies, and billing configuration; ClickHouse-backed append-only telemetry for high-volume run, cost, audit, failure, command, and context events; object storage for large artifacts, evidence bundles, snapshots, screenshots, and full transcripts.
- Ingestion pipeline: queue-backed buffering and batching between the ingestion API and storage writers so local runners can emit many events without blocking agent execution.
- Tests: source custody, idempotency, event ordering, and no-full-source-upload defaults.
- Docs/config: ingestion contract and source custody policy.

## Acceptance Criteria

- [ ] Default ingestion does not upload full source code.
- [ ] Source Custody Policy controls whether bounded cited snippets may be uploaded.
- [ ] Ingestion accepts index snapshots, graph metadata, context-pack metadata, run events, cost events, and audit events.
- [ ] Ingestion is idempotent for repeated local indexer sync attempts.
- [ ] Server records enough metadata to power the first Agent Operations Console views.
- [ ] Product/auth records are stored separately from high-volume event telemetry.
- [ ] Event ingestion supports dashboard filtering by workspace, repo, run, agent, phase, event type, severity, and time range.
- [ ] Large logs, transcripts, and evidence artifacts are stored as object-storage references, not inline product rows.

## Test Plan

- Add API/domain tests for source custody defaults.
- Add ingestion tests for idempotent snapshot and event handling.
- Add tests proving snippet upload is rejected unless policy allows it.
- Add audit tests for redaction/security/provider events.
- Add storage-routing tests proving product records, event telemetry, and large artifacts go to their intended stores.
- Add high-volume ingestion tests for queued/batched event writes and dashboard timeline queries.

## Likely Issue Slices

- Define server ingestion schema and source custody policy.
- Add Postgres product/auth schema for workspaces, teams, users, API keys, repositories, indexers, runs, review gates, policies, and billing configuration.
- Add ClickHouse event schema for run, cost, audit, failure, command, and context telemetry.
- Add object-storage artifact references for snapshots, evidence bundles, transcripts, screenshots, and large context artifacts.
- Add queue-backed ingestion buffering and batched writers.
- Add workspace/repository/indexer snapshot ingestion.
- Add run/cost/audit/failure/command event ingestion.
- Add context-pack metadata ingestion without full source upload.
- Add idempotency and policy tests.

## Blocked By

Milestone 003: Graph-Aware Retrieval Quality Gates.

## Notes

This milestone may start as a service contract or local server prototype if the production server stack is not fully provisioned. The storage direction is fixed: Postgres for product/auth truth, ClickHouse for high-volume telemetry and dashboard analytics, object storage for large artifacts, and a queue for ingestion buffering. Do not build console UI before this evidence spine exists.
