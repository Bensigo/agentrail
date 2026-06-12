# Milestone 012 — Memory telemetry + Overview

Source: spec M012.

## Outcome
Project memory items + review-suggested memory updates appear in the Memory page; the Overview page aggregates runs/cost/context/failures (no new push — it lights up as its sources fill).

## Testable proof
- Memory page shows items for the workspace (review `memory_suggestions` and/or synced repo memory). Overview shows non-zero aggregates after a real run.

## Likely issue slices
- Server: memory ingest/list endpoint backed by the existing memory store.
- CLI: push review `memory_suggestions` (tagged to run) and/or sync repo `docs/memory/*` for the workspace.
- Verify Overview aggregates populate.

## Blocked by
M009, M010 (memory suggestions come from reviews).
