# Milestone 025: Console Cost Wedge — Real-Dollar Savings View

## Source PRD

Cost-wedge arc (M022-M025). M025 surfaces the wedge to the user: the console shows **real dollars saved and spent across agents (claude/codex/cursor) over time**. This is the adoption/marketing payoff of the arc — it extends the existing costs dashboard, it does not rebuild it.

## Required Context

- `CONTEXT.md`: the console costs dashboard already exists at `apps/console/app/(dashboard)/dashboard/[workspaceId]/costs/` (`costs-client.tsx`, `costs-table.tsx`, `cost-anomaly-table.tsx`) with cost-events ingest at `apps/console/app/api/v1/ingest/cost-events` and the workspace costs API at `apps/console/app/api/v1/workspaces/[workspaceId]/costs`. M016 (codex-owned) built cost-anomaly — do NOT touch anomaly. M022 prices in real dollars; M023 produces `dollarsSaved`; M024 produces per-run dollar cost. This milestone adds a **savings** view (dollars saved vs grep-and-read baseline) and a per-agent breakdown to the existing page.
- `TASTE.md`: this is UI-visible product-quality work — must be browser-verified (CI skips console tests), match the existing dashboard's visual language, and avoid AI-generic styling. Numbers shown must be the honest, estimate-flagged figures from M023/M024, never inflated.

## Outcome

The console costs dashboard gains a real-dollar **savings** panel (dollars saved vs grep-and-read, over time) and a per-agent (claude/codex/cursor) cost+savings breakdown, fed by M023/M024 telemetry through the existing costs API. Existing anomaly and per-run cost surfaces are unchanged.

## Users

- Operator who wants to see, at a glance, dollars saved and spent across their agents
- Buyer/marketing evaluating AgentRail's ROI

## Vertical Scope

- Domain logic: extend the workspace costs API (`apps/console/app/api/v1/workspaces/[workspaceId]/costs`) to expose dollars-saved + per-agent breakdown; new savings panel + per-agent breakdown components under `costs/components/`.
- Data/storage: read existing cost-events ingest; add a savings/per-agent query (no destructive schema change).
- Integrations/jobs: consumes M024 budget-warning + per-run cost events already in the pipeline.
- Tests: component test for the savings panel (formatting, empty state); API test for the savings/per-agent query shape.
- Docs/config: none.

## Acceptance Criteria

- [ ] AC1: Costs dashboard shows a real-dollar **savings** panel (dollars saved vs grep-and-read baseline) over a time range, fed by M023 telemetry via the costs API.
- [ ] AC2: Per-agent (claude/codex/cursor) cost + savings breakdown is shown; agents with no data render an explicit empty state, not a crash.
- [ ] AC3: Estimate-flagged figures are visually distinguished (e.g. a marker/tooltip) so unknown-model estimates are not presented as exact.
- [ ] AC4: Existing cost-anomaly and per-run cost-section surfaces are unchanged (additive only).
- [ ] AC5: Browser-verified with a screenshot in the PR (per TASTE.md); component + API tests pass; all prior suites stay green.

## Likely Issue Slices

- Extend workspace costs API with dollars-saved + per-agent breakdown query.
- Savings panel component (dollars saved over time, estimate markers) on the costs dashboard.
- Per-agent cost+savings breakdown component + empty-state handling.

## Blocked By

#693 (M022 cost engine); M023 savings surface; M024 per-run cost. The API/components consume M023/M024 outputs.
