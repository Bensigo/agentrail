# Jace: acknowledge slow turns, and answer status-of-work questions

**Date:** 2026-07-26
**Status:** design, awaiting approval

## Problem

Two gaps, both surfaced by a real failure on 2026-07-26.

**Jace goes silent on slow turns.** A message that triggers real work (a PR
review, a codebase query, a subagent delegation) produces nothing in chat for
30s–2min. The only in-flight signal is the typing indicator
(`agent/lib/typing-keepalive.core.mjs`), which on Telegram is a thin grey line
that expires every ~5s and on a phone is easy to miss entirely. The user's
experience is "I sent a message and got nothing."

**Jace cannot answer "how's that going".** There is exactly one status-reporting
tool, `agent/tools/standup.ts`, and it has two problems:

1. It is dark in production. `agent/lib/standup.db.mjs:125` resolves its
   connection from `DATABASE_URL`, which is not set on the `jace` Railway
   service (only `WORKFLOW_POSTGRES_URL` is). It silently falls back to
   `postgres://agentrail:agentrail@localhost:5432/agentrail` and cannot connect.
2. It reads every workspace. `agent/lib/standup.db.mjs:53` is
   `SELECT … FROM runs ORDER BY created_at DESC LIMIT 500` — no `WHERE`, no
   workspace filter, no session. It is the only Jace tool that opens Postgres
   directly rather than going through the console's `/api/v1/runner/*` seam, so
   it bypasses the tenant resolution every other tool documents at length.
   Harmless with one workspace; a cross-tenant read the moment there are two.
   This is in scope for the open multi-tenant hardening issue (#1295).

Neither gap has an existing issue.

## Non-goals

- Model-authored progress narration ("Pulling the diff for #1468…"). Considered
  and rejected for this pass: it needs a mid-turn `say` seam that no tool in the
  codebase uses today, and it makes the acknowledgement depend on the model
  reliably calling a tool. Can layer on later; the timer below is the backstop
  either way.
- Streaming partial replies.
- Any change to how work is *executed*. This is reporting and acknowledgement
  only.

## Feature 1 — acknowledge on silence

### Mechanism

A new pure module `agent/lib/ack-on-silence.core.mjs`, deliberately a sibling of
`typing-keepalive.core.mjs` and the same shape: injected timers, keyed by
conversation, unit-testable without real time or a network.

```
createAckOnSilence({ setTimeout, clearTimeout, afterMs }) -> { start, stop, pendingCount }
```

- `start(key, postAck)` — arms a **one-shot** timer at `ACK_AFTER_MS`.
- `stop(key)` — disarms. Idempotent; safe before `start`.
- Fires **at most once per turn**. If the reply lands first, `stop` wins and
  nothing is posted. If the timer fires, the ack posts and the entry is cleared,
  so a long turn never acks twice.

`ACK_AFTER_MS = 4000`. Below that, turns that would have replied anyway get an
unnecessary ack. Above ~6s the chat already reads dead. 4s also keeps phase with
`TYPING_REFRESH_MS`, so the two timers don't interleave awkwardly.

### Copy

One line: `On it.`

Nothing more. At 4s Jace does not yet know what it is doing, and inventing
progress detail it cannot substantiate is the failure mode this design is trying
not to build. This matches `instructions.md`'s "Voice and reply length" section:
direct, dry, no ceremony.

### Per-channel wiring

`turn.started` already receives `(data, channel, ctx)` on every channel — the
same handler `typing-keepalive` is driven from today.

| Channel  | Delivery seam | Notes |
|---|---|---|
| Telegram | `channel.telegram.post(text)` | Verified against eve's own `telegramChannel.d.ts:101`, which documents `post` as send-with-splitting. Already used in `message.completed`. |
| Discord  | `deliverDiscordBubble` + `resolveSessionAuthAttributes(ctx)` from `agent/lib/discord-followup.core.mjs` | **Must not use `channel.discord.post()`** — see below. |
| Slack    | `channel.thread.post` | No `turn.started` handler exists today; one is added. |
| Console  | the seam `console.ts`'s `message.completed` uses | No `turn.started` handler exists today; one is added. |

**Why Discord is special.** `agent/channels/discord.ts` documents at length that
in this hosted-shared-bot deployment `channel.discord.post()` always falls back
to a Bot-API channel message, which needs View Channel + Send Messages on that
specific channel — a private channel returns `50001 Missing Access`, silently
swallowed. That was the production bug fixed in #1463 by routing replies through
the interaction followup webhook instead. The ack is a reply like any other and
must use the same path, with the same fallback behaviour on a missing credential
or an expired 15-minute window.

### Error handling

The existing code's claim that eve "does not export `defaultEvents`" is
**correct**, and an earlier draft of this spec wrongly said otherwise. For the
record, so nobody re-litigates it:

- `defaultEvents` is declared in eve's *internal*
  `dist/src/public/channels/telegram/defaults.d.ts`, but the public entrypoint
  `eve/channels/telegram` (`index.d.ts`) re-exports only `defaultTelegramAuth`.
  There is no importable path to it — `#public/...` is a Node subpath import,
  package-internal.
- The default `turn.failed` handler posts a user-facing error message built from
  `formatErrorHint`/`extractErrorId` out of `#internal/logging.js`, also
  unreachable. Overriding `turn.failed` would clobber that message *and* drop
  the error id, with no clean way to reproduce it.

So: **do not override `turn.failed` or `session.failed`.** The ack is stopped on
the real `message.completed` and on `turn.completed`.

**Known residual race, accepted.** A turn that fails in under 4s posts eve's
error message, and the still-armed ack then fires at 4s — the user sees the error
followed by `On it.` Cosmetic, narrow, and strictly better than losing eve's
error reporting. If it proves annoying in practice, the follow-up is to override
the failure handlers and re-author the error copy in Jace's own voice.

**Verify during implementation:** whether eve also emits `turn.completed` after
`turn.failed`. `protocol/message.js` constructs them as separate events and the
emit order is not evident from the type stubs. If `turn.completed` does fire on a
failed turn, the existing `turn.completed` handler already closes this race and
nothing further is needed. Determine it against the running sidecar, not the
`.d.ts` — that mistake is what produced the incorrect claim above, and it is the
same mistake #1463 was root-caused on twice.

**Stop placement.** `message.completed` currently stops the typing keepalive
*before* its `finishReason === "tool-calls"` early return, so typing dies at the
first tool call and the rest of a multi-tool turn shows no indicator. Both the
ack `stop` and the typing `stop` move *below* that guard, so a tool-calling turn
keeps both alive until it actually replies. This is an intentional fix to
existing behaviour and gets its own test.

A `postAck` that throws — or whose returned promise rejects — must never
propagate into the turn, same `safe()` wrapper `typing-keepalive` already uses.

### Testing

Pure core, injected timers, no real time:

- fires after `afterMs`
- does **not** fire when stopped at `afterMs - 1`
- fires exactly once across a long turn
- two conversation keys stay isolated
- `stop` before `start` is a no-op
- a throwing `postAck` is swallowed

Channel wiring gets the treatment `discord-followup` already has: a fake channel
asserting **which seam** was called, so a regression back to
`channel.discord.post()` fails the test rather than production.

## Feature 2 — status of work

### Shape

A new read-only tool `agent/tools/fetch_work_status.ts` plus a pure core
`agent/lib/fetch_work_status.core.mjs`, modeled directly on
`agent/subagents/reviewer/lib/fetch_pr_diff.core.mjs`: single GET, injected
transport, no `approval` (read-only tools do not gate), and a degraded result
rather than a throw on every failure — config missing, unreachable, 401/403,
404, 409, 429, 5xx, bad body.

Input: an optional `ref` (issue number, PR number, or run id).

- absent → the workspace's current live picture
- present → that one item

### Console route

`GET /api/v1/runner/work-status`, guarded by `requireJaceConsoleSecret` — the
same guard every Jace-coordinator route uses.

Tenant resolution is `eveSessionId → jace_sessions → chat_identity →
workspaceId`, resolved server-side, never from a caller-supplied workspace id —
identical to `runner/pr-review`, `runner/repos`, and `runner/goals`. Every query
carries `WHERE workspace_id = $resolved`.

Returns:

- in-flight runs — state, started-at, cost
- queue entries and their states
- recent PRs with links
- open human escalations

It keeps standup's honest-gap posture: the `runs` table has no error/reason
column, so a "why did it fail" question is answered with what *is* known and an
explicit no-source note, never a confabulated reason.

A `ref` that belongs to another workspace returns 404, exactly as an unknown ref
would — it never reveals whether the ref exists elsewhere.

### Intent routing

`instructions.md` gains a rule under tool selection. The trigger is **intent, not
a phrase**: any question about the state of work in flight — "how's that going",
"did it land", "where are we on X", "is it done", "what's happening with the
review" — calls `fetch_work_status` before answering, and answers only from what
it returns. Never from memory of an earlier turn, which goes stale the moment the
fleet moves.

### Retiring standup's direct-DB edge

`standup` is re-implemented over the same console route with a summary flag.
This:

- deletes the unscoped `SELECT … FROM runs` with no `WHERE`
- removes the need for `DATABASE_URL` on the `jace` service entirely
- leaves one status path instead of two overlapping ones

`agent/lib/standup.core.mjs`'s rendering and its `WHY_FAILED_NO_SOURCE` policy
are kept as-is; only the data source changes. `standup.db.mjs` is deleted.

### Testing

Core: every degraded branch, mirroring `fetch_pr_diff.core.test`.

Route: tenant resolution from the ledger; a `ref` from another workspace 404s;
missing workspace 409s; response shape. Console routes are not covered by CI's
node job, so the route is additionally exercised against a local dev console
before merge.

## Sequencing

Three PRs.

1. **Ack** — `ack-on-silence.core.mjs`, Telegram + Discord wiring, the stop
   placement fix in `message.completed`, Slack and console `turn.started`
   handlers. Independent of the others.
2. **Console route** — `GET /api/v1/runner/work-status` + tests.
3. **Tool + retirement** — `fetch_work_status` tool and core, `instructions.md`
   intent rule, standup re-pointed at the route, `standup.db.mjs` deleted.
   Stacks on 2.

## Open item to verify before building

Whether a Discord interaction followup posted *before* any assistant message
behaves as expected — the ack becomes followup #1 and the real reply followup #2.
Followups are repeatable inside the 15-minute window, so this should be fine, but
this exact path has been root-caused twice (#1463 and its follow-up hardening),
and the `.d.ts` stubs disagreed with the compiled runtime both times. A short
spike against the running sidecar before PR 1 builds on the assumption.

## Context: how this came up

A PR review request over Telegram failed with a degraded fetch. Root cause was
unrelated to either feature — the Telegram webhook still pointed at the Jace
sidecar's native `/eve/v1/telegram` route instead of the console's hosted door,
so no `chat_identities` row and no `jace_sessions` ledger row ever existed for
Telegram, and every workspace-scoped tool 404'd. That was fixed on 2026-07-26 by
setting `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET_TOKEN` on the console
service and repointing `setWebhook` at
`https://www.heyjace.com/api/v1/connectors/telegram/webhook`.

Two things that failure exposed are in scope here: Jace was silent for the whole
attempt, and when it finally spoke it paraphrased a structured degraded result
into a guess ("make sure the PR is public") rather than reporting the tool's own
`note`. The second is not fixed by this design and is worth its own issue.
