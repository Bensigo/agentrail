# Milestone 011 — Failures telemetry

Source: spec M011.

## Outcome
When a run fails (implementation failure, verification gate, timeout, merge failure), a `failure_events` row is pushed (type, message, phase, evidence), linked to the run. The Failures page + run-detail populate.

## Testable proof
- A deliberately-failing run produces a `failure_events` row keyed by the run id; the Failures page renders it.

## Likely issue slices
- `insertFailureEvents` (db-clickhouse) + barrel export.
- `POST /api/v1/ingest/failure-events` route + vitest.
- CLI: `afk/runner.py` `_fail(...)` + pipeline verification-failure/timeout paths push `failure_events` keyed by the canonical run id. Non-fatal. + pytest.

## Blocked by
M009.
