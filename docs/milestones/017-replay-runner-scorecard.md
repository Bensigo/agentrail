# Milestone 017: Replay & Runner Scorecard

## Source PRD

GitHub issue #542 — (https://github.com/Bensigo/agentrail/issues/542)

## Required Context

- `CONTEXT.md`: AFK runs are unattended; operators need replay without reading local log files. Runner Scorecard surfaces evidence-based comparison of Codex, Claude, Cursor, Hermes, and custom runners. Every number must be traceable to underlying run events. Idempotency required on all ingest paths — the outbox pattern means events may be replayed; use ReplacingMergeTree or dedup key.
- `TASTE.md`: Time is primary axis — replay timeline sorts by ts, with clear visual hierarchy for stalls and retry loops. Scorecard is a dense comparison table; each cell links to underlying runs. No vanity metrics — every scorecard column (success_rate, review_fix_rate, human_review_rate, cost_per_merged_pr, context_efficiency) must be drillable. Browser screenshot evidence required. Real-time streaming not in scope — replay is event-driven at flush time.

## Outcome

An operator opens a run's **Replay** tab and sees a timeline of all AFK flight-recorder events: slot utilization, tool calls, context pack fetches, review gate events, and retry loops — with the longest stall, most expensive retry loop, and any digest mismatches highlighted. The **Runner Scorecard** page (already routed at `/scorecard`) is populated with real data: a filterable comparison table of all runners that have executed in the workspace, showing five outcome metrics per runner, each cell linking to the underlying runs.

## Users

- AgentRail operators replaying unattended AFK runs to diagnose stalls and retry loops
- Team leads evaluating which runner performs best on their repositories before committing
- Buyers evaluating AgentRail across multiple runners on their own repositories

## Vertical Scope

This milestone touches:

- UI: New **Replay** tab on `runs/[runId]` detail page — vertical timeline with slot utilization, tool calls, context pack fetches, review gate events, retry loops; stall and retry highlights; digest mismatch badges. Populate existing `scorecard/` route with real runner comparison data — filterable by repository, time range, and task type; each cell links to underlying runs
- API/routes: New tRPC procedures `runs.replayTimeline` and `scorecard.runners`; new server ingest endpoint `POST /api/v1/ingest/afk-events`
- Domain logic: `AFK Event Ingester` — validates batch schema, writes to `afk_run_events` ClickHouse table, idempotent upsert by `(run_id, ts, slot)`; `Runner Scorecard Aggregator` — joins runs + run_events + review_gates + cost_events by runner_name/model field, computes 5 metrics, returns runner-keyed ScoreRow map with underlying run_id lists
- Data/storage: New ClickHouse table `afk_run_events` — columns `run_id String`, `workspace_id String`, `slot UInt8`, `event_type LowCardinality(String)`, `ts DateTime64(3)`, `payload_json String`, `digest String`; engine ReplacingMergeTree partitioned by toYYYYMM(ts), ordered by (run_id, ts); migration in `packages/db-clickhouse`. Runs table: confirm `runner_name` field exists; if not, add migration to `packages/db-postgres` schema
- Integrations/jobs: `agentrail/afk/telemetry.py` — add `flush_afk_events()` function that reads `.agentrail/afk/events.jsonl` and POSTs to `/api/v1/ingest/afk-events`; call at run end and on outbox flush
- Tests: Unit tests for Runner Scorecard Aggregator (fixture runs with known metrics → correct ScoreRow values and run_id lists); integration test for AFK Event Ingester (duplicate batch → idempotent, no duplicate rows)
- Docs/config: Document `runner_name` field assumption; document that replay is flush-time, not live-streaming

## Acceptance Criteria

- [ ] `afk_run_events` ClickHouse table created with correct schema, engine, and partition key + migration
- [ ] `runner_name` field confirmed on runs table (or migration added)
- [ ] `agentrail/afk/telemetry.py` has `flush_afk_events()` that reads events.jsonl and POSTs to `/api/v1/ingest/afk-events`
- [ ] `POST /api/v1/ingest/afk-events` endpoint accepts batches, writes to afk_run_events idempotently, returns `{ accepted: N, duplicate: N }`
- [ ] Replay tab on run detail page renders vertical timeline with correct event types; longest stall highlighted; retry loops highlighted; digest mismatches badged
- [ ] Runner Scorecard Aggregator returns correct ScoreRow values for fixture data (unit test passes)
- [ ] Scorecard page renders a comparison table with all 5 metrics per runner; filter controls for repository, time range, and task type work; each cell links to underlying runs
- [ ] AFK Event Ingester is idempotent — replaying the same batch twice produces no duplicate rows (integration test passes)
- [ ] Browser screenshots of the Replay tab (with seeded AFK events showing a stall highlight) and Scorecard page (with multiple runners) attached to the PR

## Test Plan

- `pytest packages/db-clickhouse/src/__tests__/test_runner_scorecard_aggregator.py`
- `pytest packages/db-clickhouse/src/__tests__/test_afk_event_ingester.py` (idempotency)
- Manual: run `flush_afk_events()` against a seeded events.jsonl, open Replay tab, verify timeline renders; seed scorecard fixtures for multiple runners, open scorecard page, verify comparison table

## Likely Issue Slices

- Add `afk_run_events` ClickHouse table + migration
- Confirm/add `runner_name` field on runs table + migration if needed
- Implement `flush_afk_events()` in `agentrail/afk/telemetry.py`
- Implement `POST /api/v1/ingest/afk-events` endpoint + AFK Event Ingester module
- Implement Runner Scorecard Aggregator module + unit tests
- Add idempotency integration test for AFK Event Ingester
- Add tRPC procedures `runs.replayTimeline` and `scorecard.runners`
- Build Replay tab on run detail page — timeline component with stall/retry/digest highlights
- Populate Scorecard page with real data + filter controls + cell drill-down links
- Write fixture seed script (events.jsonl + multi-runner runs) for end-to-end verification

## Blocked By

[[016-telemetry-health-cost-anomaly]] — `outbox_flushed` run event from Milestone 016 is the natural trigger point to call `flush_afk_events()`; coordinate emit order. [[015-agent-behavior-failures-gates]] — no hard dependency, but review gate events in the replay timeline rely on the `category` field added in Milestone 015.

## Notes

Runner identification relies on `runner_name` on runs. If the field does not exist and is not derivable from `model` on run_events, the Postgres migration to add it is a hard precondition; verify before starting the scorecard aggregator. Context efficiency is defined as `tokens_saved / total_tokens`; both values must be present on the run record (tokens_saved already exists per prior milestones). The scorecard does not require all four runners to be present — it renders whatever runners have data in the filtered window.
