# Milestone 009 — Context packs telemetry

Source: `docs/superpowers/specs/2026-06-12-telemetry-pipeline-design.md` (M009).

## Outcome
A run's detail shows the context it gathered (sources + tokens used/budget) and **tokens saved** vs reading the same files in full. `context_packs` is populated, linked to the run by canonical id.

## Testable proof
- After an `agentrail run`/`afk`, `context_packs` has a row per phase keyed by the run id; the Context Packs page and the run-detail context block render it.
- Tokens-saved is shown (full-file baseline − tokens_used).

## Likely issue slices
- `insertContextPacks` (db-clickhouse) + barrel export.
- `POST /api/v1/ingest/context-packs` route + vitest (mirror cost-events).
- CLI: push a context_pack row from `run.json.contextRetrieval` after each phase in `agentrail/run/pipeline.py`, keyed by `rc.run_id`; include a full-file baseline for tokens-saved. Non-fatal. + pytest.

## Blocked by
None.
