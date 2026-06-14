# Milestone 024: Per-Run Cost Attribution + Budgets

## Source PRD

Cost-wedge arc (M022-M025). M024 attaches a **real-dollar cost** to each AFK run/issue and adds budget guardrails, so an operator can see what an unattended run actually cost and be warned before it overspends. Prices through M022; complements (does not duplicate) the existing cost-anomaly surface.

## Required Context

- `CONTEXT.md`: AFK flight-recorder journal is `events.jsonl` per run (`agentrail/afk/`); run cost is already surfaced per-run in the console at `apps/console/app/(dashboard)/dashboard/[workspaceId]/runs/[runId]/components/cost-section.tsx`, and cost events ingest at `apps/console/app/api/v1/ingest/cost-events`. M022 provides `cost_for(model, ...)`. Cost-anomaly detection (M016, codex-owned) already exists at `costs/components/cost-anomaly-*` — do NOT reimplement anomaly; this milestone adds attribution + budgets only.
- `TASTE.md`: Evidence over claims — a run's reported dollar cost must reconcile with its token telemetry. Budget warnings must be actionable (state the threshold, the current spend, and the run/issue).

## Outcome

`agentrail cost [--run ID] [--since REF] [--json]` summarizes real-dollar cost per AFK run/issue, priced via M022. A configurable budget threshold emits a warning (CLI + journal event) when a run's projected/actual cost exceeds it. No existing anomaly or cost-section contract changes.

## Users

- Operator monitoring what an unattended AFK run cost
- Operator who wants a warning before a run overspends a budget
- Developer reconciling run cost against token telemetry

## Vertical Scope

- Domain logic: `agentrail cost` command aggregating per-run/per-issue token telemetry from AFK journal + run metadata, priced via M022 `cost_for`; budget threshold config (env/config) with a warning emitted to CLI output and the run journal when exceeded.
- Data/storage: no new schema (reads existing journal/telemetry); budget threshold stored in config.
- Integrations/jobs: budget warning written as a journal event consumable by the console.
- Tests: `tests/cli/test_cost.py` (per-run dollar aggregation + JSON schema); `tests/afk/test_budget_warning.py` (warning fires above threshold, silent below).
- Docs/config: document the budget config key.

## Acceptance Criteria

- [ ] AC1: `agentrail cost [--json]` returns per-run/per-issue real-dollar cost aggregated from existing telemetry, priced via M022 `cost_for`.
- [ ] AC2: `--run ID` scopes to one run; `--since REF` scopes by time/commit; totals reconcile with summed per-run costs.
- [ ] AC3: A configurable budget threshold emits a warning (CLI + journal event naming threshold, current spend, run/issue) when exceeded; no warning below threshold.
- [ ] AC4: All dollar math routes through M022 `cost_for`; no duplication of the M016 anomaly logic.
- [ ] AC5: `tests/cli/test_cost.py` and `tests/afk/test_budget_warning.py` pass; all prior suites stay green.

## Likely Issue Slices

- `agentrail cost` command: aggregate per-run/per-issue dollar cost from AFK telemetry via M022 `cost_for`.
- Budget threshold config + warning (CLI + journal event) when a run exceeds it.
- Tests: per-run aggregation + budget-warning fixtures.

## Blocked By

#693 (M022 cost engine — `cost_for` pricing function).
