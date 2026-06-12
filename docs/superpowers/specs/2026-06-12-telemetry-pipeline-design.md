# Complete the CLI → dashboard telemetry pipeline

Status: approved direction (2026-06-12). Epic.

## Problem

The console dashboard has surfaces for Overview, Runs (+ detail), Context Packs,
Review Gates, Failures, Memory, Costs, and Repo Health — but the CLI only pushes
**4 of the ~9 data sources** those surfaces read. So most sections render empty,
not because of UI bugs but because the CLI→server push for them was never built.

Wired today (over the `.agentrail/server.json` + Bearer + `/api/v1/ingest/*`
rail, all linked by the **canonical run id** `uuid5(session_id, issue)`):

- `runs` (registration), `run_events` (timeline), `cost_events` (tokens spent),
  `index_snapshots` (repo health).

Not wired (data exists in the CLI; just never pushed):

- **`context_packs`** — the context a run gathered + tokens used/budget/saved.
- **review findings** — the bugs/issues a review found and how to fix them
  (`afk/review.py` `ReviewOutcome.blocking` / `memory_suggestions`), plus
  review-gate pass/fail state.
- **`failure_events`** — why a run failed.
- **memory** — project memory items / review memory suggestions.
- **Overview** — aggregates all of the above, so it's empty until they are.

## Goal

Every agent run shows, in the dashboard, what it actually did: the **context it
gathered** (sources + tokens used vs a full-file baseline = *tokens saved*),
**tokens spent** (already wired), **reviews** (gate state), **bugs found + how to
fix them**, and **failures**. Memory and Overview populate as a result.

## Principle (reuse the proven pattern)

Each source is one **ingest endpoint** (Bearer auth, workspace from key, repo ∈
workspace) + one **CLI push** (non-fatal), tagged with the **canonical run id**
so it links to the registered run. The canonical id already flows: afk computes
`run_uuid(session_id, issue)`, registers the run with it, tags `run_events`, and
passes it to the pipeline via `agentrail run issue --run-id` (so `cost_events`
and now `context_packs` use it too). No new identity work — just more pushers.

Source code never leaves the machine — only metadata/metrics, consistent with
the control-plane contract already followed by index snapshots and costs.

## Milestones

### M009 — Context packs (highest value: the AgentRail pitch)

**Shows:** context gathered + tokens used/budget + **tokens saved** vs full-file.

- Data the CLI already has: `run.json.contextRetrieval`
  (`selectedContextTokens`, `wastedContextTokens`, `retrievalBudget`,
  `selectedSources`, `citations`) and the per-phase pack files under
  `.agentrail/context/packs/`.
- `context_packs` columns: `workspace_id, run_id, context_pack_id, token_budget,
  tokens_used, anchors_extracted, sources_considered, occurred_at`. Add a
  `full_file_tokens` (or compute it) so the UI can show **tokens saved =
  full_file_tokens − tokens_used** (the benchmark engine already computes the
  full-file baseline for a set of sources; reuse that estimator).
- Server: `POST /api/v1/ingest/context-packs` (mirror cost-events) +
  `insertContextPacks` (db-clickhouse).
- CLI: in `agentrail/run/pipeline.py`, after a phase builds its context pack,
  push a `context_packs` row keyed by `rc.run_id`. Non-fatal.
- Dashboard Context Packs page + the run-detail "context gathered / tokens saved"
  block read `getContextPacksForRun` (already exists).

### M010 — Review findings + gates (bugs + how to fix)

**Shows:** review gate pass/fail per round, and the blocking findings
(title, severity, file, suggested fix).

- Data: `afk/review.py` `ReviewOutcome` (`blocking: List[Finding{title, severity,
  file, …}]`, `memory_suggestions`) produced on every afk review round.
- Server: a review-gate ingest endpoint upserting Postgres `review_gates` (the
  Review Gates page reads these) + a findings payload (gate id → findings).
- CLI: `afk/runner.py` review loop pushes the gate result + findings, keyed by
  the canonical run id, at each `_review_loop` round.
- Dashboard Review Gates page + run-detail "Review Gates" section populate.

### M011 — Failures

**Shows:** why a run failed (type, message, phase, evidence).

- `failure_events` columns: `workspace_id, run_id, repository_id, failure_type,
  message, evidence, phase, severity, occurred_at, event_id`.
- Server: `POST /api/v1/ingest/failure-events` + `insertFailureEvents`.
- CLI: `afk/runner.py` `_fail(...)` and the pipeline's verification-failure /
  timeout paths push a `failure_events` row keyed by the canonical run id.
- Dashboard Failures page + run-detail populate.

### M012 — Memory

**Shows:** project memory items + review-suggested memory updates.

- Data: review `memory_suggestions` + the repo's `docs/memory/*` (the
  `agentrail memory` surface).
- Server: a memory ingest/list endpoint backed by the existing memory store.
- CLI: push review `memory_suggestions` (tagged to run) and/or sync repo memory
  items for the workspace.
- Dashboard Memory page populates; Overview aggregates everything.

## Build order & method

Server-first within each milestone (endpoint + db insert, independently
testable), then the CLI push — exactly as M007→M008 and run-registration shipped.
Dogfood via `agentrail prd create → milestone → issue create → afk` where
practical; verify each console push locally (CI doesn't run console vitest) and
do a live run after each milestone so the corresponding section lights up.

M009 first (it's the core value prop and unblocks "tokens saved"), then M010
(the bugs+fixes you most want to see), then M011, then M012. Overview needs no
new push — it lights up as its sources fill.

## Non-goals

- New dashboard visual design (the surfaces already exist).
- Re-architecting run identity (the canonical id is already wired).
- Pushing source code to the server (metadata/metrics only).
