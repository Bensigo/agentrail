# PRD: Jace Goal Loop — schedule work until a goal is reached

## Problem

The autonomous loop we have today is a queue drainer, not a goal chaser. The
Heartbeat polls trigger-labeled issues, runs each in a sandbox, posts the
outcome back, and **idles when the queue is empty**
(`agentrail/heartbeat/runtime.py:1-24`). Nothing evaluates "is the objective
reached" and nothing generates the next unit of work — a human does. Goals like
"reach 80% coverage," "burn down the flaky tests," or "keep deps current"
require a person to keep filing issues by hand.

The missing layer is a goal loop: **decompose → execute → evaluate → refill or
stop**. It cannot live in the factory. AgentRail's safety contract is
Execution-Only Autonomy — "connectors ingest goals humans defined, the agent
never invents them" (`agentrail/connectors/__init__.py:6`). A goal loop invents
work by construction; putting it inside the factory breaks the exact property
that makes sandbox runs and merge policy defensible. So the loop lives one
level up, in **Jace** — which already owns ideation→issues, already files
issues through the single gated create-issue tool, and already receives every
terminal run outcome (`apps/jace/agent/channels/run-outcome.ts`). Decision
locked 2026-07-10.

**This is not a code move.** No file moves from `agentrail/` to `apps/jace/`.
The factory loop is already exactly the executor we want; the work is adding
the missing decision layer in Jace plus read surfaces in the console. Naming:
the existing per-issue `workflow.goals` in `.agentrail/state.json` (the run's
execution contract — summary, acceptance criteria, non-goals injected into
context packs, `agentrail/run/state.py:54-147`) keeps its name and place. The
new entity is a **workspace goal** and never touches that file.

## Goals

1. **Goal entity** — `goals` table in AgentRail Postgres (workspace-scoped):
   objective, machine-checkable success check, leash (max issues + max spend),
   repository binding, status lifecycle
   (`active | reached | leashed | paused | abandoned`), creator attribution.
   Plus `goal_events` for the audit trail (issue filed, check evaluated,
   leash consumed, status change).
2. **Goal intake in chat** — a `to-goal` Jace skill turns a conversation into
   a goal draft (objective + check + leash), confirmed by the human in-thread
   before it exists. A human states every goal; Jace never self-creates one.
3. **Decompose → file** — Jace plans the next issue(s) toward the goal and
   files them via the **existing** gated `create_issue` tool
   (`approval: always()`), goal-stamped (a `goal:<slug>` label plus a Goal
   line in the house-format body). No second write path into the factory.
4. **Evaluate on outcome** — on each terminal run outcome Jace maps
   issue→goal, records a `goal_event`, evaluates the check, then refills
   (files the next issue), declares the goal reached, or escalates. A
   scheduled tick covers time-based goals ("deps current weekly") and acts as
   a stuck watchdog.
5. **Console visibility** — a goal card in the console's Jace zone: objective,
   check progress vs target, issues filed/merged, spend vs leash, pause /
   abandon controls; the digest reports per-goal progress. (Slots into the
   #1120 two-zone IA, but this PRD stands alone — the card is a read API +
   one component either way.)
6. **Kill switch** — per-goal `paused`, plus a workspace flag `jaceGoalLoop`
   default **OFF** (rollout safety, not a demo gate).

## Non-goals

- **No factory changes.** The Heartbeat stays a queue drainer whose
  termination is "queue empty"; `agentrail/` gains zero goal awareness beyond
  the existing per-issue `workflow.goals`, which is unchanged.
- **No merge-policy change.** Goal-filed issues obey the same merge policy
  and the same verify gate as any other issue.
- **No vibes checks.** v1 success checks are machine-checkable only (see
  Design 3). If it can't be checked by a command or a metric, it isn't a
  goal — it's a conversation.
- **No relaxing `approval: always()`** on create_issue for goal-filed issues
  in v1. Same seam, same gate — "gate at queue entrances." Auto-file becomes
  a per-goal opt-in only after the loop has earned trust.
- **No multi-repo goals** in v1 — a goal binds to exactly one repository.

## Design

Anchor files: `agentrail/heartbeat/runtime.py:1-24` (drainer — stays),
`agentrail/connectors/__init__.py:1-20` (doctrine),
`agentrail/run/state.py:54-147` (per-issue goals — unchanged),
`agentrail/run/budget_leash.py` (leash semantics to mirror),
`apps/jace/agent/tools/create_issue.ts` (single gated write path),
`apps/jace/agent/channels/run-outcome.ts` (evaluate trigger),
`apps/jace/agent/skills/to-issues/` (decomposition to reuse),
`packages/db-postgres/src/schema/` (new `goals.ts`).

1. **Schema** — `goals` + `goal_events` tables, workspace- and
   repository-scoped. Drizzle gotcha: the migration must land in
   `_journal.json` (numbers have collided before) or it is silently skipped.
2. **Intake** — the `to-goal` skill grills the objective the way `grill-me`
   grills requirements: propose a concrete check, propose leash defaults
   (e.g. 10 issues / $50), get in-thread confirmation, then persist via a new
   gated `create_goal` tool (`approval: always()`). Goal text passes the same
   write-side secret/deny scan as memory items — goal text flows into issue
   bodies, so it crosses the chat→factory trust boundary.
3. **Success check contract** — two kinds in v1, both needing zero new write
   paths into the factory:
   - **`metric`** — a threshold over data AgentRail Postgres already holds
     (runs, queue states, costs). Evaluated by Jace directly, read-only.
   - **`command`** — a repo-local command (e.g. coverage report) encoded as an
     acceptance criterion of a goal-stamped house-format issue. The factory
     already enforces acceptance criteria through the verify gate, so "final
     goal issue green" carries the check result back through the existing
     outcome path. The check command is decided at intake, not invented
     mid-loop.
4. **Evaluate-and-refill** — extend the run-outcome hand-off: after the
   platform notification, map the issue to its goal (label), record the
   `goal_event`, and decide: **refill** (invoke decomposition, file the next
   issue through create_issue), **reached** (update status, announce
   in-thread + digest), or **leashed/stuck** (see 6). The scheduled tick
   re-evaluates time-based goals and flags goals with no movement. Scheduling
   primitive: verify eve@0.19.0's scheduler against the running sidecar
   before relying on it; fallback is a console-side cron hitting a Jace
   route — decide during implementation and document in the PR.
5. **Console** — read API for goals + events; goal card in the Jace zone
   (objective, check progress, issues filed/merged, spend vs leash, pause /
   abandon writing goal status); one digest line per active goal
   ("Coverage: 71%→78%, 4 PRs merged, $11.30, leash 60%"). Names, never raw
   UUIDs. Spend figures come from the run costs already recorded per run
   (priced via `agentrail/run/pricing.py` upstream).
6. **Leash & stuck rule** — per-goal `max_issues` and `max_spend_usd`,
   consumed on each filed issue and each recorded run cost; exhaustion →
   status `leashed` + in-thread escalation (mirrors `budget_leash`'s
   hard-stop-to-human at goal granularity). Stuck rule: N consecutive
   non-green outcomes on one goal (default 2) → `paused` + escalation. Both
   are terminal until a human acts.

## Measurement (definition of success)

- A chat conversation creates a goal with check + leash; its issues flow
  through the existing gated create-issue path — zero new write paths into
  the factory, zero-line diff under `agentrail/`.
- On a terminal run outcome, Jace records a `goal_event` and files the next
  issue, marks the goal reached, or escalates — verified end-to-end on one
  real goal against a real repo.
- The console shows the goal card with live progress and spend; pausing a
  goal halts refill within one outcome cycle.
- Leash exhaustion and the stuck rule each produce exactly one in-thread
  escalation and stop the loop — demonstrated, not assumed.
- `jaceGoalLoop` default OFF; enabling one workspace turns the loop on with
  no deploy.

## Risks

- **Runaway loop** (unreachable goal) → leash + stuck rule + pause; `leashed`
  is terminal until a human acts, and every filed issue is human-approved in
  v1 anyway.
- **Prompt injection** via goal text flowing into issue bodies → write-side
  scan at intake; the create-issue approval gate keeps a human countersigning
  everything the loop writes.
- **Check gaming (Goodhart)** — the loop optimizes the metric, not the
  intent → checks are human-confirmed at intake; `goal_events` keeps the
  audit trail; the digest shows what actually merged, not just the number.
- **Eve scheduling uncertainty** → verify the primitive against the running
  sidecar first; console-cron fallback keeps the tick out of the critical
  path.
- **Name collision** with per-issue `workflow.goals` → different entity,
  different store; this PRD and the state docs cross-reference each other so
  nobody "refactors" the run contract by mistake.
