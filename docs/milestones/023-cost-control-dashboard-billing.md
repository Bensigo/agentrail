# Milestone 023: Cost-Control Dashboard + Billing

## Source

Product repositioning (see Milestone 022). For engineers/startups the dashboard
is **not** an enterprise ops console — it is a focused **cost-control + billing**
surface. The one headline metric is **savings net of subscription price**,
normalized to $ across providers (Claude / Codex / Cursor). Everything that is
not cost / savings / billing is demoted to Settings.

## Required Context

- `apps/console/app/(dashboard)/dashboard/[workspaceId]/page.tsx`: today the
  overview is 9 equal count tiles (Runs, Context Packs, Failures, Review Gates,
  Costs, Repos & Health, Memory, API Keys, Team) — inventory, not the cost story.
- `apps/console/app/(dashboard)/dashboard/[workspaceId]/runs/[runId]/components/cost-section.tsx`:
  per-run savings already computed — `tokensSaved = packTokensSaved +
  cache_tokens`. The data exists; it just isn't aggregated to the hero.
- `apps/console/app/(dashboard)/dashboard/[workspaceId]/scorecard/page.tsx`:
  already tracks `Cache tokens` and `Cache ratio` — promote cache-hit from a
  metric to an actionable lever panel.
- `@agentrail/db-clickhouse` `getWorkspaceTelemetryCounts` (`totalCostUsd`,
  `totalTokens`) and `@agentrail/db-postgres` `getWorkspaceOverviewCounts`: the
  aggregation entry points.
- Real-dollar cost engine from Milestone 022 — the dashboard prices everything
  through it; no `chars/4` in the UI.

## Outcome

The workspace overview leads with ROI. An operator sees, for their team/repos:
**$ saved vs $ subscription** (did it pay for itself), tokens avoided, and a
per-provider cost split — not a workspace inventory. Supporting panels show
where to save more. A billing page shows plan, usage this cycle, and
savings-vs-spend.

## Remove / demote (to a single Settings area)

- **API Keys, Team / Members, Memory-as-a-count, raw Context-Packs count, raw
  Failures count** as hero tiles.
- **Review Gates** and **Failures** as top-level nav — fold the pages into
  Settings / run-detail. **Keep the underlying gate + failure events**: they
  feed the context-lazy-run detector and the retry-tax view. Demote the surface,
  reuse the data.

## Add

- **Hero = savings net of subscription**, normalized to $, with tokens avoided
  and `$ saved vs $ subscription`, broken down by repo. Aggregated from existing
  per-run `tokensSaved`.
- **Per-provider cost split** (Claude / Codex / Cursor) — mandatory once all
  three agents are in scope; priced via the Milestone 022 engine.
- **Cache-hit-rate panel** — built on the existing `cache_ratio`, showing
  "$ left on the table if low" so it reads as a lever, not a vanity metric.
- **Model-tier mix panel** — % of spend on reasoning / implementation / cheap
  tier, per provider (consumes Milestone 024 routing data); surfaces routing
  opportunity at a glance.
- **Context-lazy run detector** — runs that bypassed AgentRail and read full
  files anyway (from the retained gate signal); the "where money leaks" list.
- **Context-efficiency per run** — `selectedTokens` vs `fullFileTokens` vs
  `wastedTokens` (already computed in the benchmark metric set).
- **Billing / plan page** — plan, usage this cycle, savings-vs-spend.

## Go deeper

- **Savings attribution** — decompose saved $ into its sources: **caching /
  retrieval-vs-full-file / tier-routing / cross-turn dedup / retries-avoided**.
  This is the centerpiece: it tells the operator which lever to pull next *and*
  itemizes the 50–70% claim instead of asserting it.
- **Multi-turn cumulative cost** — single-shot is blind to the compounding where
  the real 50–70% lives; track cumulative session cost, not per-call.

## Acceptance Criteria

- [ ] Workspace overview hero shows $ saved, $ saved vs subscription, and tokens
      avoided, aggregated from per-run `tokensSaved`, priced via the real-$
      engine (no `chars/4` in the UI).
- [ ] Per-provider cost split renders for Claude / Codex / Cursor.
- [ ] Cache-hit panel reads from `cache_ratio` and shows $-left-on-the-table.
- [ ] Context-lazy run detector lists runs that read full files without an
      AgentRail context call, sourced from retained gate/failure events.
- [ ] API Keys, Team, Memory, Review Gates, Failures removed from the overview
      hero and reachable from Settings; no data loss (events still ingested).
- [ ] Billing page shows plan / usage / savings-vs-spend.
- [ ] Savings figures derive from real per-run data, not the fixture benchmark.

## Test Plan

- Aggregation: unit-test the per-workspace savings + per-provider roll-up from
  fixture run telemetry.
- Component: overview renders hero ROI with zeroed and populated telemetry;
  context-lazy detector renders the leak list from a seeded gate event.
- Regression: demoted surfaces still ingest events (no telemetry regression).

## Likely Issue Slices

- Savings + per-provider aggregation queries
- Overview hero (ROI) + demotion of inventory tiles to Settings
- Cache-hit lever panel (from `cache_ratio`)
- Context-lazy run detector (from retained gate signal)
- Model-tier mix panel (consumes Milestone 024)
- Billing / plan page
- Savings attribution (deeper slice)

## Blocked By

Milestone 022 (real-dollar cost engine) — the dashboard prices everything
through it.
