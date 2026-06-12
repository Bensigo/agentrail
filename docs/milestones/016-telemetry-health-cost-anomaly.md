# Milestone 016: Telemetry Health & Cost Anomaly

## Source PRD

GitHub issue #542 — (https://github.com/Bensigo/agentrail/issues/542)

## Required Context

- `CONTEXT.md`: Run Events are append-only; Cost Events are metered events for tokens, model calls, embeddings, reranking, storage. "Empty dashboard sections are ambiguous — nothing happened and telemetry push broke look identical." The outbox pattern means events may be replayed; idempotency required on all ingest paths. Cost anomaly detection surfaces overages; it does not change billing logic.
- `TASTE.md`: Missing signals must be visually obvious — red for missing, green for present. Every number must be actionable and drillable. Anomaly badges must link to the underlying run and cost events. Dense table pattern with filter bar, time range controls, status badges.

## Outcome

Every run detail page shows a **Telemetry Health** checklist: eight named signals (run_start, context_pack, cost_event, review_gate, failure_event, memory_items, index_snapshot, outbox_flush) shown as present (green) or missing (red), with a `missing_since` timestamp for absent signals — making broken telemetry visually obvious instead of an empty section. The **Costs** page gains a cost anomaly view: runs, repos, or models that exceed the rolling baseline (mean + N·sigma) are badged as anomalies, filterable by model/phase/repo, with each anomaly row linking to the offending run and its cost events. Anomaly detection fires during the run so operators can act before it completes.

## Users

- AgentRail operators diagnosing whether a run produced no findings because nothing happened vs. because telemetry silently failed
- AgentRail operators triaging unexpected cost spikes

## Vertical Scope

This milestone touches:

- UI: Telemetry Health checklist section on `runs/[runId]` detail page; Cost Anomaly panel on existing `costs/` route — anomaly badge, baseline overlay line on cost chart, anomaly table with model/phase/repo/cost/deviation columns
- API/routes: New tRPC procedures `runs.telemetryHealth` and `costs.anomalies`
- Domain logic: `Telemetry Completeness Checker` module — accepts run_id, checks presence of 8 named signals, returns `CheckResult[]{ signal, present, missing_since }`; `Cost Baseline Computer` module — accepts model + phase + repo, queries cost_events over trailing window (default 30 days), computes mean + stddev, returns baseline stats + anomaly flag if observation exceeds mean + N·sigma (configurable N, default 2)
- Data/storage: No new ClickHouse schema changes required — this milestone reads existing `run_events`, `cost_events`, `context_packs`, `review_gates`, `failure_events`, `memory_items`, `index_snapshots` tables, plus `.agentrail/afk/outbox.jsonl` outbox status surfaced via the existing run state
- Integrations/jobs: Outbox flush status must be readable server-side per run — confirm `.agentrail/afk/outbox.jsonl` is already pushed to the server as part of run state or add a lightweight `outbox_status` field to run_events; cost anomaly detection must fire mid-run by hooking into the cost_event ingest path
- Tests: Unit tests for Telemetry Completeness Checker (complete event set → all present; event set missing cost_event → correct missing signal); unit tests for Cost Baseline Computer (known mean/stddev sequence → anomaly flag fires above threshold, does not fire below)
- Docs/config: Document configurable N·sigma sensitivity and baseline_window_days (inherited from Milestone 014 workspace setting)

## Acceptance Criteria

- [ ] Telemetry Completeness Checker returns all-present for a complete event set (unit test passes)
- [ ] Telemetry Completeness Checker returns correct missing signal + missing_since for an incomplete event set (unit test passes)
- [ ] Cost Baseline Computer fires anomaly flag above threshold and suppresses it below (unit test passes)
- [ ] Run detail page shows Telemetry Health checklist with 8 named signals; missing signals shown in red with missing_since timestamp
- [ ] Outbox flush status (flushed / pending / not applicable) rendered in the Telemetry Health checklist
- [ ] Costs page shows anomaly-badged rows for runs exceeding baseline; each row links to the run and its cost events
- [ ] Cost anomaly detection fires during a live run (mid-run cost_event ingest triggers anomaly check), not only post-completion
- [ ] Baseline overlay line visible on cost chart showing mean + N·sigma band
- [ ] Browser screenshots of telemetry health checklist (with a missing signal) and cost anomaly table attached to the PR

## Test Plan

- `pytest packages/db-clickhouse/src/__tests__/test_telemetry_completeness_checker.py`
- `pytest packages/db-clickhouse/src/__tests__/test_cost_baseline_computer.py`
- Manual: seed fixture run with intentionally missing cost_event, open run detail, verify red missing signal; seed anomalous cost event, verify anomaly badge on costs page

## Likely Issue Slices

- Implement Telemetry Completeness Checker module + unit tests
- Implement Cost Baseline Computer module + unit tests
- Confirm/add outbox flush status field on run state (server-readable)
- Hook cost anomaly check into cost_event ingest path (mid-run detection)
- Add tRPC procedures `runs.telemetryHealth` and `costs.anomalies`
- Build Telemetry Health checklist section on run detail page
- Build Cost Anomaly table + baseline overlay on costs page
- Write fixture seed script for end-to-end verification

## Blocked By

[[014-context-quality-rot-watch]] — `baseline_window_days` workspace setting may be shared; coordinate if settings schema changes.

## Notes

The outbox status signal is the most novel of the eight — existing telemetry does not explicitly record whether `.agentrail/afk/outbox.jsonl` was fully flushed. A minimal approach is to emit a `outbox_flushed` run event at flush time in `agentrail/afk/telemetry.py`; the completeness checker then looks for this event type. This can be done in this milestone without requiring the full AFK event ingester from Milestone 017.
