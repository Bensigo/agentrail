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
- Data/storage: server-side object model for workspaces, teams, users, API keys, repositories, codebase units, indexers, snapshots, runs, events, failures, review gates, memory items, costs, and audits.
- Tests: source custody, idempotency, event ordering, and no-full-source-upload defaults.
- Docs/config: ingestion contract and source custody policy.

## Acceptance Criteria

- [ ] Default ingestion does not upload full source code.
- [ ] Source Custody Policy controls whether bounded cited snippets may be uploaded.
- [ ] Ingestion accepts index snapshots, graph metadata, context-pack metadata, run events, cost events, and audit events.
- [ ] Ingestion is idempotent for repeated local indexer sync attempts.
- [ ] Server records enough metadata to power the first Agent Operations Console views.

## Test Plan

- Add API/domain tests for source custody defaults.
- Add ingestion tests for idempotent snapshot and event handling.
- Add tests proving snippet upload is rejected unless policy allows it.
- Add audit tests for redaction/security/provider events.

## Likely Issue Slices

- Define server ingestion schema and source custody policy.
- Add workspace/repository/indexer snapshot ingestion.
- Add run/cost/audit event ingestion.
- Add context-pack metadata ingestion without full source upload.
- Add idempotency and policy tests.

## Blocked By

Milestone 003: Graph-Aware Retrieval Quality Gates.

## Notes

This milestone may start as a service contract or local server prototype if the production server stack is not yet selected. Do not build console UI before this evidence spine exists.
