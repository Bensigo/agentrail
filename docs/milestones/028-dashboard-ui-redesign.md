# Milestone 028: Dashboard UI Redesign — Dense, Crafted, No AI Slop

## Source PRD

The Agent Operations Console dashboard (`apps/console/app/(dashboard)/`, ~18 pages) uses the correct brand tokens but inconsistent, partly generic composition. Redesign the dashboard UI for a dense, crafted observability experience — strong information architecture, scannable data surfaces, consistent components — **keeping the design tokens, fonts, and colors unchanged**, and following the same anti-AI-slop direction as the landing redesign.

## Required Context

- `CONTEXT.md`: dashboard shell is `apps/console/app/(dashboard)/dashboard/[workspaceId]/layout.tsx`; pages include overview (`page.tsx`), `costs`, `runs` (+ `runs/[runId]`), `failures`, `repos`, `memory`, `context-packs`, `context-quality`, `review-gates`, `scorecard`, `api-keys`, `teams`, `members`. Tokens + type scale in `TASTE.md` § Console Design Guide and `apps/console/app/globals.css` — **do not change them**.
- `docs/design/redesign-direction.md`: the anti-AI-slop art-direction bar. For dashboards, especially: **scanability/density over hero treatment**, no decorative backgrounds, real data, consistent table/empty/loading/error patterns.
- `TASTE.md`: dense observability patterns; visual hierarchy proportional to surface; explicit empty/loading/error/success states; mandatory browser-screenshot evidence.

## Outcome

A consistent, dense, crafted dashboard: a refined shell (sidebar/nav, workspace switcher, top bar) and a shared component language (data tables, cards, stat headers, empty/loading/error states) applied across pages — scannable, no oversized hero treatment, no AI-slop decoration, same brand tokens.

## Users

- Operator monitoring AFK runs, cost, failures, and context quality who needs to scan and act fast.

## Vertical Scope (each slice shippable + browser-verified)

- Dashboard shell redesign: sidebar/nav IA, workspace switcher, top bar, consistent page header pattern, density tuning.
- Shared component pass: standardize data tables, stat/summary headers, cards, and explicit empty/loading/error/success states into reusable primitives.
- Overview/home page redesign: scannable at-a-glance state (health, cost, runs) using the shared primitives — no oversized hero.
- Core data pages pass (costs, runs, failures): apply the shared table/state patterns; dense, scannable.
- Detail pages pass (run detail, failure detail, review-gate detail): consistent detail layout (header + sections + data), monospace for IDs/timestamps/paths.

## Acceptance Criteria

- [ ] AC1: Dashboard shell (sidebar/nav, workspace switcher, top bar, page-header pattern) is consistent across all dashboard pages.
- [ ] AC2: Shared primitives exist for data tables, summary/stat headers, and empty/loading/error/success states, and are used by the redesigned pages (no one-off re-implementations).
- [ ] AC3: No oversized hero treatment on dashboard surfaces; layout favors scanability/density (TASTE UI Standards); no decorative backgrounds/glow.
- [ ] AC4: Data values, IDs, timestamps, file paths, JSON use the monospace token; UI chrome uses Inter — per the design guide.
- [ ] AC5: Every redesigned page has explicit empty, loading, and error states (not just the happy path).
- [ ] AC6: Design tokens, fonts, and color values are unchanged.
- [ ] AC7: Each PR includes before/after browser screenshots (desktop + mobile) of the changed pages.

## Likely Issue Slices

- Dashboard shell redesign (nav/IA, workspace switcher, top bar, page-header pattern, density).
- Shared component primitives (tables, stat headers, empty/loading/error/success states).
- Overview/home redesign (scannable, no hero).
- Core data pages pass (costs, runs, failures).
- Detail pages pass (run/failure/review-gate detail).

## Blocked By

The shell + shared-primitives slices should land before the page passes (pages consume them). Otherwise independent. Shares `docs/design/redesign-direction.md` with M027.
