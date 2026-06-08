# Milestone 005: Agent Operations Console V1

## Source PRD

docs/prd/context-compiler-enterprise-control-plane.md

## Outcome

Teams can use the Agent Operations Console to switch workspaces and inspect runs, context packs, failures, review gates, costs, repositories/indexing health, memory, API keys, and teams.

## Users

- Team lead
- Platform admin
- Reviewer
- Enterprise security owner

## Vertical Scope

This milestone may touch:

- UI: workspace switcher, dense tables, filters, run detail, context-pack detail, failure detail, review-gate status, cost views, repo/indexing health, memory, API keys, and teams.
- API/routes: read APIs for ingested server objects and event timelines.
- Domain logic: status derivation, filtering, drilldown, and evidence display.
- Data/storage: queries over workspace, run, context, cost, audit, and health data.
- Tests: user-visible console flows and authorization-sensitive views.
- Docs/config: console information architecture and design principles.

## Acceptance Criteria

- [ ] Users can switch workspaces.
- [ ] Users can view runs and drill into one run's context packs, failures, review gates, costs, and events.
- [ ] Users can inspect context-pack included and excluded items with citations and reasons.
- [ ] Users can view repository/indexing health and stale index indicators.
- [ ] Users can view cost breakdowns by workspace, team, repo, API key, and run where data exists.
- [ ] Users can manage or inspect Memory, API Keys, and Teams at a v1 level.
- [ ] UI follows the console design guide in TASTE.md (dense, operational, evidence-first).

## Test Plan

- Add UI route/component tests for workspace switching and run drilldown.
- Add API tests for console read models.
- Add authorization tests for workspace-scoped access.
- Add visual verification screenshots for core console pages.

## Likely Issue Slices

- Build workspace switcher and console shell.
- Build Runs list and run detail timeline.
- Build Context Packs detail view with included/excluded citations.
- Build Failures and Review Gates views.
- Build Costs and Repos/Indexing Health views.
- Build Memory, API Keys, and Teams v1 views.

## Blocked By

Milestone 004: Server Ingestion Spine.

## Notes

The console should be operational and dense. Avoid landing-page composition, decorative analytics, or views that cannot be traced back to server events and context artifacts.
