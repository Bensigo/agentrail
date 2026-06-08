# ADR 0005: Postgres Plus ClickHouse For AgentRail Ingestion Storage

## Status

Accepted

## Context

AgentRail must show admins and team members what AI coding agents are doing: runs, phases, commands, failures, costs, audit events, context choices, review gates, and evidence. This creates observability-shaped data: high-volume, append-only, time-indexed, heavily filtered, and often queried as timelines or aggregations.

Postgres remains the right system for product truth: users, teams, workspaces, repositories, API keys, permissions, billing configuration, source custody policies, runs, and review gates. It should not be the only store for high-volume logs and agent telemetry.

## Decision

AgentRail server ingestion will use a split storage model:

- Postgres stores product/auth truth and relational workflow state.
- ClickHouse stores high-volume append-only telemetry: run events, cost events, audit events, failure events, command events, context retrieval events, and dashboard timeline data.
- Object storage stores large artifacts: full transcripts, large logs, evidence bundles, screenshots, index snapshots, and context-pack artifacts.
- A queue buffers ingestion and lets workers batch writes to the correct store.

## Consequences

This gives the dashboard full observability transparency without forcing Postgres to serve as both product database and analytics/log database.

The system has more moving parts than a Postgres-only MVP, but the boundary is clean: transactional product data in Postgres, firehose telemetry in ClickHouse, bulk payloads in object storage.

Default enterprise source custody remains metadata-first. Full source upload is not required. Bounded snippets are uploaded only when workspace policy allows it.

## Notes

Founder pilots may start with free or low-cost managed tiers where possible, but the architecture should not pretend Postgres alone is the long-term ingestion answer.
