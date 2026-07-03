---
name: standup
description: Report a factory standup from the AgentRail Postgres database READ-ONLY, using ONLY schema-backed facts — run counts by state, total cost, open PR links, human escalations, and queue states. Never invents a "why it failed" narrative; the runs table has no error/reason column, so a failure reason is honestly reported as unavailable.
---

# Standup

Give a factory standup by reading the AgentRail Postgres database **read-only**
and reporting only facts that are backed by a real database column. This is a
READ-ONLY skill: it opens no write-capable connection and changes nothing.
Never call `create_issue` from this skill — a standup publishes nothing.

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

## Read-only guarantee

Database access goes through `agent/lib/standup.db.mjs`, which opens the
connection with a hard read-only guard (session `default_transaction_read_only`
plus a `READ ONLY` transaction around every query) and exposes only SELECT
helpers. No write-capable connection is ever constructed. Keep it that way: a
standup only ever reads.
