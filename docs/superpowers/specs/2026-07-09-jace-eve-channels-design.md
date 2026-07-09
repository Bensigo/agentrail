# Jace channels on Eve's native primitives — corrected design

**Status:** design · **Date:** 2026-07-09 · **Issues:** #1047 (Telegram), #1050
(Discord + Slack), #1100 (iMessage)

## Why this doc exists

The outbound channel-migration work (#1047/#1050/#1100) was built as a bespoke
"the console POSTs a text blob to Jace at `/eve/v1/notify`, Jace forwards it to
the channel" handoff. **Eve has no such endpoint and no such convention.** Eve
ships channels as a first-class primitive; the old design reimplemented delivery,
credentials, and threading that Eve provides natively, and pointed the console at
a made-up path. Only the console half shipped (flag-OFF); the Jace half was never
written. Nothing is deployed, so correcting it is cheap — this doc is the
corrected, Eve-grounded design and the PR plan.

## Eve facts (verified against `eve@0.19.0` — npm exports + eve.dev docs)

- **Channel files live in `agent/channels/<name>.ts`**, default export; the
  filename (no extension) is the channel ID. Eve walks `agent/` and auto-discovers
  channels/tools/skills/schedules (`eve info` lists them).
- **Native channel modules, env-based creds (self-host, no Vercel Connect needed):**
  - Telegram — `telegramChannel({ botUsername })`; `TELEGRAM_BOT_TOKEN`,
    `TELEGRAM_WEBHOOK_SECRET_TOKEN`; inbound mounts at `/eve/v1/telegram`; the
    deployed URL is registered with Telegram via `setWebhook`.
  - Discord — `discordChannel()`; `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`,
    `DISCORD_BOT_TOKEN`; inbound mounts at `/eve/v1/discord`.
  - Slack — `slackChannel({ … })` (greenfield here).
- **Outbound / proactive / cross-channel push** is the blessed mechanism, not raw
  HTTP: `receive(channel, { message, target, auth })` from a schedule `run`
  handler, or `args.receive(channel, { message, target, auth })` from inside a
  route handler. Target shape is per-platform — Telegram `{ chatId }`, Slack
  `{ channelId }`. `auth` is forwarded to `session.auth.initiator` so the target
  channel's handlers and Jace's tools can identify who initiated.
- **Custom channel** for the console→Jace boundary:
  `defineChannel({ routes: [ POST("/…", async (req, args) => { … args.receive(chan, {…}); return new Response("ok"); }) ] })`
  from `eve/channels`. It mounts under `/eve/v1/<filename>`. This is exactly the
  docs' "incident webhook pivots to a Slack investigation thread" pattern.

## Corrected architecture

The console (Next.js, the DB/secret holder) and Jace (the Eve sidecar) are
genuinely separate processes, so an HTTP boundary between them is legitimate — the
bug was never "there is a boundary", it was *the boundary pointed at an invented
endpoint and Jace re-rolled what Eve gives for free.* We keep the boundary, fix
its target, and build the Jace side on native channels.

**Why route outbound through Jace at all** (the point of the migration): Jace owns
the *conversation*. A run-outcome delivered through a Jace channel lands in a
repliable thread the human can answer, and inbound replies are handled by the same
channel — one bidirectional surface. The legacy console senders are fire-and-forget
(no reply path). That is the capability the cutover buys; it is not cosmetic.

### Jace — `apps/jace/agent/channels/`

| File | Module | Role |
| --- | --- | --- |
| `telegram.ts` | `telegramChannel({ botUsername })` | Native Telegram inbound + outbound. |
| `discord.ts` | `discordChannel()` | Native Discord inbound + outbound. |
| `slack.ts` | `slackChannel({ … })` | Greenfield Slack (may land in a follow-up). |
| `run-outcome.ts` | `defineChannel({ routes: [POST("/…")] })` | The console's real push target. Parses the terminal-outcome payload and calls `args.receive(<channel>, { message, target, auth })` into the right platform channel. |

`run-outcome.ts` imports the platform channels (`import telegram from "./telegram.js"`,
`import discord from "./discord.js"`) and dispatches on `payload.channel`. The
shared bot credentials live in Jace's env; the console never sends a secret over
the wire — only the non-secret `target` (e.g. Telegram `chatId`).

### Console — `apps/console/app/api/v1/runner/result/notify.ts`

- Delete the invented `JACE_NOTIFY_URL = ${EVE_HOST}/eve/v1/notify`. Point the Jace
  handoff at the **real** `${EVE_HOST}/eve/v1/run-outcome` route.
- Reshape the payload to Eve's vocabulary: `{ workspaceId, channel, message,
  target: { chatId | channelId }, auth, outcome, issueNumber, prUrl, costUsd }`.
  The console supplies the per-workspace `target` from its DB; Jace holds the bot
  creds and does delivery + threading.
- Keep the best-effort, **no-fallback** contract (exactly-once: a transient blip
  must not double-fire after Jace already delivered) and the terminal-only caller.

## What stays / changes / goes

- **Stays (correct as-is):** `jaceOwns{Telegram,Discord,Slack}Notify` +
  `ConnectorConfig.*Notify` per-workspace opt-ins (pure, unit-tested; the concept
  "this workspace's channel is migrated to Jace" is right). The console as DB/target
  holder. The legacy console senders (#888) as the pre-cutover fallback, unchanged.
- **Changes:** the console handoff *target* (`/eve/v1/notify` → `/eve/v1/run-outcome`)
  and *payload shape* (Eve `{ channel, message, target, auth }`). **Build** Jace
  `agent/channels/*`. Document the new env vars in `apps/jace/README.md`.
- **Removed:** the invented `/eve/v1/notify` convention.

## PR plan (small, incremental)

1. **This spec.**
2. **Jace native channels** — `agent/channels/{telegram,discord,run-outcome}.ts`
   + `node --test` unit tests for the `run-outcome` route's dispatch (inject a fake
   `receive`, assert channel selection + `{ message, target, auth }` mapping,
   payload validation, unknown-channel rejection); README env vars. Slack may split
   into a follow-up.
3. **Console rewire** — `notify.ts` points at the real route with the Eve-shaped
   payload; delete the fake endpoint; update `notify.test.ts`. Flag-OFF preserved.

## Server gate

Channel files are correct and reviewable **now** — Eve's model is "agents as
ordinary files", so getting the files right does not need a running server. What
needs the deployed sidecar (#1038 / #1101) is *running* them: registering the
Telegram `setWebhook`, live delivery, and the per-workspace cutover. The
`jaceOwns*Notify` flags stay **default-OFF** until each workspace's cutover is
verified to deliver exactly once.
