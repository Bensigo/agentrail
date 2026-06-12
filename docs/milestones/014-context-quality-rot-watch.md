# Milestone 014: Context Quality & Rot Watch

## Source PRD

GitHub issue #542 — (https://github.com/Bensigo/agentrail/issues/542)

## Required Context

- `CONTEXT.md`: Context Pack is a bounded cited artifact; Context Rot means context becoming misleading because source code, docs, ownership, or generated summaries no longer match current repo state; Retrieval Quality Gate must pass before Context Compiler is production-ready; "not noise" means required-source inclusion 100%, citation coverage 100%, stale/denied leakage 0. Precision-at-budget, citation_coverage, stale_count, and denied_count must be first-class DB citizens, not derived at query time.
- `TASTE.md`: Dense observability UI pattern — overview-first filterable table, time-series charts, status badges (yellow=stale/caution, red=regressed), monospace for IDs/hashes/timestamps, no vanity metrics, every number drills to underlying run events. UI PRs require browser screenshot evidence.

## Outcome

An operator can open the **Context Quality** dashboard, see a time-series chart of `precision_at_budget`, `citation_coverage`, `stale_count`, and `denied_count` for any repository over the last 30 days, spot automatically-flagged regressions against the rolling baseline, and drill into a **Context Rot Score** card that ranks which stale memory items, index snapshots, and outdated packs are contributing to risk — all traceable to real `context_pack` events already flowing through telemetry.

## Users

- AgentRail operators monitoring context quality across runs
- Developers diagnosing why an agent produced poor output on a specific repository

## Vertical Scope

This milestone touches:

- UI: New route `dashboard/[workspaceId]/context-quality` — time-series chart panel (precision_at_budget, citation_coverage, stale_count, denied_count), regression badge, rot score card with ranked contributor drill-down list
- API/routes: New tRPC procedures `contextQuality.metrics` and `contextQuality.rotScore` in `apps/console`
- Domain logic: `Quality Metrics Aggregator` module — accepts time range + repo filter, queries context_packs, computes rolling baseline (default 30-day, min 5 runs), emits regression flags; `Context Rot Scorer` module — joins memory_items.lastUsedAt, index_snapshots.indexed_at, context_packs.updated_at, context_events.item_hash, outputs rot_score (0–100) + ranked stale contributors
- Data/storage: ClickHouse `context_packs` table — add columns `precision_at_budget Float32`, `citation_coverage Float32`, `stale_count UInt16`, `denied_count UInt16`, `source_hash_list Array(String)`
- Integrations/jobs: `agentrail/run/context_pack_push.py` — populate new columns before push
- Tests: Unit tests for Quality Metrics Aggregator (baseline computation, regression flag, no false positive) and Context Rot Scorer (known fixture ages → expected rot_score and contributor order)
- Docs/config: New `baseline_window_days` workspace setting (default 30, range 7–90); "insufficient data" state shown when fewer than 5 runs exist in window

## Acceptance Criteria

- [ ] `context_packs` ClickHouse table has columns `precision_at_budget`, `citation_coverage`, `stale_count`, `denied_count`, `source_hash_list` and a migration in `packages/db-clickhouse`
- [ ] `agentrail/run/context_pack_push.py` populates all five new fields before push
- [ ] Quality Metrics Aggregator returns correct baseline, regression flag on deterioration, and no false positive on stable metrics (unit test passes)
- [ ] Context Rot Scorer returns expected rot_score and top-contributor order given fixture data (unit test passes)
- [ ] `dashboard/[workspaceId]/context-quality` page renders time-series charts for all four metrics, a regression badge when the latest value crosses the baseline, and a rot score card with a contributor drill-down
- [ ] When fewer than 5 runs exist in the baseline window, the UI shows "Insufficient data" instead of a spurious regression flag
- [ ] Each rot score contributor row links to the underlying context pack, memory item, or index snapshot that is stale
- [ ] Browser screenshot of the context-quality page with seeded fixture data attached to the PR

## Test Plan

- `pytest packages/db-clickhouse/src/__tests__/test_quality_metrics_aggregator.py` — fixture-seeded unit tests
- `pytest packages/db-clickhouse/src/__tests__/test_context_rot_scorer.py` — fixture-seeded unit tests
- Manual: run fixture seed script, open `context-quality` route, verify chart and rot score card render correctly with expected values

## Likely Issue Slices

- Add 5 columns to ClickHouse `context_packs` + migration
- Extend `context_pack_push.py` to populate new fields
- Implement Quality Metrics Aggregator module + unit tests
- Implement Context Rot Scorer module + unit tests
- Add tRPC procedures `contextQuality.metrics` and `contextQuality.rotScore`
- Build `context-quality` page: time-series chart panel + regression badge
- Build rot score card component with ranked contributor drill-down
- Add `baseline_window_days` workspace setting + "insufficient data" guard
- Write fixture seed script for end-to-end verification

## Blocked By

None.

## Notes

Source hash churn (tracking when `source_hash_list` diverges significantly across runs) is a secondary signal; the rot scorer should include it but it need not dominate the score. The decay function applied to staleness ages is configurable and defaults to linear (days_stale / threshold_days capped at 1.0) to keep the scorer fully deterministic without ML.
