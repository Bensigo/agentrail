---
name: standup
description: Report a factory standup from the workspace-scoped console work-status route READ-ONLY, using ONLY schema-backed facts — run counts by state, total cost, open PR links, human escalations, and queue states. Never invents a "why it failed" narrative; the runs table has no error/reason column, so a failure reason is honestly reported as unavailable.
---

# Standup

Give a factory standup by reading the workspace-scoped console work-status
route **read-only** and reporting only facts that are backed by a real
database column. This is a READ-ONLY skill: it writes nothing and changes
nothing. Never call `create_issue` from this skill — a standup publishes
nothing.

## What you may report (schema-backed only)

Every figure you report must come from a real column. The allowed columns are
enumerated in `agent/lib/standup.core.mjs` (`RUNS_ALLOWED_FIELDS` /
`QUEUE_ALLOWED_FIELDS`). In practice that is:

- **Run counts by state** — from `runs.status`, whose only values are
  `queued`, `running`, `success`, `failed`. Report the count in each state.
- **Total cost** — the sum of `runs.cost_usd`.
- **Open PR links** — the non-empty `runs.pr_url` values.
- **Escalations** — queue entries whose `queue_entries.state` is
  `escalated-to-human` (an issue the loop handed back to a person).
- **Queue states** — the count of `queue_entries` in each `state`
  (`queued`/`parked`/`running`/`green`/`escalated-to-human`/`blocked`).

Use the `buildStandup` / `renderStandup` helpers to shape the report. They
derive every field from the columns above and nothing else.

## What you must NOT report

- **Do not narrate why a run failed.** The `runs` table records only a `status`
  — there is **no** `error`, `reason`, `log`, or `failure_summary` column, and
  no failure-summary source is wired into the standup for v1. The failure events
  themselves live in append-only ClickHouse and are out of scope here.
- When asked **"why did run X fail"**, answer honestly with the
  `answerWhyFailed` helper: there is **no failure-detail source available**, and
  report only what IS known for that run (its state, cost, and PR link). Never
  invent, infer, or guess a reason — a confabulated cause is worse than an
  honest "unknown".
- Do not describe GitHub CI status. Dashboard/run status reflects the local
  verify gate, not GitHub CI (see CONTEXT.md); the standup speaks only to the
  columns it can read.

## Degraded read

This skill's ONLY data source is `agent/lib/fetch_work_status.core.mjs`'s
`fetchWorkStatus` — a single GET to the console. That means standup can now
fail to read at all (it did not have this failure mode when it opened
Postgres directly): if the console is unconfigured, unreachable, or this
conversation has no workspace yet, the tool returns the fetch's DEGRADED
result verbatim — `{ ok: false, degraded: true, reason, note }` — with no
`report`, no `standup`, and no `whyFailed` key at all.

Recognize that shape and report it plainly: relay the `note` as-is, and stop
— never render an empty standup ("0 runs, 0 escalations") in its place, and
never guess at the factory's state to fill the gap. A degraded read is an
honest gap, not a fact, exactly like a degraded `fetch_backlog` read in the
backlog-triage skill.

## Read-only guarantee

Data access goes through `agent/lib/fetch_work_status.core.mjs`'s
`fetchWorkStatus`, a single GET to the console's workspace-scoped
`/api/v1/runner/work-status` route (scoped server-side to this conversation's
own workspace, via the `jace_sessions` ledger — never a model-supplied
workspace id). There is no write path here at all: the tool never opens a
database connection, never calls a mutating endpoint. Keep it that way: a
standup only ever reads.

Because the route caps how many rows it returns, a standup may see only a
PAGE of runs/queue entries, not the workspace's complete history. When that
happens, the rendered report says so explicitly (e.g. "N most recent —
truncated") instead of presenting a partial count as if it were the total —
never mistake "the most recent page" for "everything".
