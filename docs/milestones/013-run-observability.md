# Milestone 013 — Run observability (open the black box)

Source: spec `2026-06-12-telemetry-pipeline-design.md`, extended 2026-06-12.

## Outcome
The run detail page answers "what did the agent actually do, what did it cost, and where was the bottleneck" without leaving the dashboard:

- **Cost & tokens panel** — model used, total cost, input/output/cache token split, per-phase rows. Cache reads surfaced as "tokens served from cache" (the cheap tokens AgentRail's reuse avoids paying full price for).
- **Context drill-down** — tokens used vs budget plus the actual sources selected (path, reason, score, included/excluded), so users see what the agent was given and why.
- **Agent activity log** — per-turn summaries extracted from the agent transcript (thinking snippets + tool actions), pushed as `agent_activity` run events and rendered in the timeline.
- **Bugs found & fixes** — review findings (severity, description, suggested fix) attached to review gates and rendered on the run.
- **Failures** (M011) — failure events pushed on failed phases/timeouts, rendered on the run and the Failures page.
- **Memory** (M012) — review memory suggestions tagged to the run, rendered on the run and the Memory page.
- **Phase waterfall** — per-phase duration + tokens + cost bars derived from run events + cost events; the slowest/most expensive phase is flagged. This is the bottleneck finder.

## Testable proof
One real afk run produces a run detail page showing: model + non-zero cost, context sources with reasons, agent activity entries, per-phase waterfall, and (when the review finds issues) bugs with suggested fixes.

## Issue slices
1. cost_events phase + token-split columns; `getRunCosts`; run-detail Cost & tokens panel.
2. M011 failures: insert + ingest route + CLI push on failure paths + run-detail section.
3. Context pack items: CLI pushes selected sources; ingest accepts items; run-detail drill-down (uses existing `context_events` table + `getContextPackItems`).
4. Agent activity log: CLI transcript summarizer → `agent_activity` run events; timeline renders collapsible entries.
5. Review findings: extend review-gate push + schema with findings[]; run-detail renders bugs + fixes.
6. Phase waterfall panel on run detail (pure console; consumes 1 + existing events).
7. M012 memory: push review memory suggestions tagged to run; Memory page + run-detail section.

## Blocked by
M009, M010 (merged). Slice 6 blocked by slice 1. Slice 7 blocked by slice 5 only for the suggestion source.
