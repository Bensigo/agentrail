# Milestone 007 — Cost ingest endpoint

Source: PRD #451 (Agent cost capture → cost_events). Parent: #398.

## Outcome

The server accepts `POST /api/v1/ingest/cost-events`, validates Bearer auth and that the `repository_id` belongs to the key's workspace, and writes accepted events to the ClickHouse `cost_events` table. The endpoint is live and independently testable (via `curl`) before any CLI work ships.

## Why this is first

The CLI push target must exist before the CLI can be wired to it. This side is independently deployable and reviewable on its own — exactly the server-first ordering used for the index-snapshot ingest rail (#449), which this mirrors.

## Testable proof

- `POST /api/v1/ingest/cost-events` with a valid Bearer token and a well-formed payload → HTTP 202 `{ "accepted": n }`, and a row appears in ClickHouse `cost_events` with the correct `model`, `tokens`, `cost_usd`, `run_id`, `repository_id`.
- The same POST with a `repository_id` not belonging to the key's workspace → HTTP 404, no insert.
- Malformed body (missing required field) → HTTP 400.

## Likely issue slices

- Add `insertCostEvents(events)` to `packages/db-clickhouse/src/queries.ts` (mirror `insertIndexSnapshots`: derive a deterministic `event_id`, dedupe, insert), and surface it from the package barrel `src/index.ts`.
- Create `apps/console/app/api/v1/ingest/cost-events/route.ts` — Bearer auth via `requireBearer`, `workspace_id` from the key, validate repo ∈ workspace via `getRepository`, batch (1–100) shape validation, `insertCostEvents`, `202 { accepted }`; 502 on insert error (mirrors `index-snapshots/route.ts`).
- vitest route test: 401 (no key), 202 + correct insert args, 404 (repo not in workspace, insert not called), 400 (malformed).

## Blocked by

None — can start immediately.
