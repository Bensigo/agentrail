# Telegram shared-bot cutover

How to migrate an existing per-workspace-bot workspace (Telegram wired
straight to the sidecar's native `/eve/v1/telegram`) onto the hosted
product's shared bot (issue #1262). This is additive — nothing below removes
or rotates the sidecar's own Telegram config; it stays exactly as documented
in `apps/jace/README.md`'s Channels section, because replies still post out
through that same native channel after the cutover (see
`apps/jace/agent/channels/hosted-inbound.ts`'s header comment).

The workspace's old `connectors` row for `telegram` (the per-workspace bot
token stored by the setup wizard / Connectors page) is never read, written,
or deleted by any of this — it stays in Postgres untouched.

## 0. Telegram approval buttons — this gate is now CLOSED (issue #1273)

Previously: the console's webhook accepted `message`/`edited_message` only —
every other update kind, including `callback_query` (inline-keyboard button
taps), failed the shape check and returned `{ ok: true, ignored: true }`.
Telegram delivers ALL update types to whichever one URL `setWebhook` currently
points at, so repointing it (step 2) didn't filter anything on Telegram's
side — button taps just landed on a route that silently dropped them: no
error, no retry, the tap did nothing. That made this cutover unsafe for any
workspace depending on Telegram-button approvals.

Issue #1273 closes this. The webhook
(`apps/console/app/api/v1/connectors/telegram/webhook/route.ts`) now handles
`callback_query` explicitly, branching on `data`:

- `ar:`-prefixed data is the console-gated approval seam's OWN button
  (`create_issue`/`create_workspace`/`create_repo`'s approval function,
  #1273 PR ②): looked up by its opaque callback token, sender-checked against
  the approval's own chat identity, atomically flipped, answered, and the
  message edited in place to show the outcome.
- ANY other `callback_query` — including Eve's own stock `eve:`-prefixed HITL
  buttons — is forwarded VERBATIM to the sidecar's real `/eve/v1/telegram`
  channel, with the same `x-telegram-bot-api-secret-token` header Telegram
  sent. This is what keeps Eve-native approval buttons working through the
  cutover even for gated tools PR ② hasn't (yet, or ever) been swapped to the
  console seam: nothing about this forwarding depends on PR ② having landed.

**No gate remains.** A workspace depending on Telegram-button approvals can
cut over safely: the three gated tools' buttons work either via the new ar:
seam (once #1273 PR ② swaps their approval function) or, until/unless that
swap happens for a given tool, via the forwarding bridge above — either way,
a tap is never silently dropped. Rollback (step 4) is unaffected either way.

## 1. Set the console's shared-bot env vars

Copy the exact values the sidecar already has configured for its native
`/eve/v1/telegram` channel — same bot, same secret, no new BotFather bot
needed — onto the **console** service:

- `TELEGRAM_BOT_TOKEN` — same value as the sidecar's.
- `TELEGRAM_WEBHOOK_SECRET_TOKEN` — same value as the sidecar's (one bot, one
  secret — the console's webhook route verifies against this exact env var).
- `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — the bot's `@username`, no `@` (same
  value as the sidecar's `TELEGRAM_BOT_USERNAME`). This one is inlined into
  the console's **browser** bundle at `next build` time, not read fresh at
  container start — a plain restart after adding it to `deploy/.env` is not
  enough. Today's `apps/console/Dockerfile` / `deploy/docker-compose.prod.yml`
  have no build-arg plumbing for `NEXT_PUBLIC_*` vars (this is the first one
  in the app), so confirm however you deploy the console actually gets this
  value into the build — don't assume `docker compose up -d --build` alone
  picks it up.

Redeploy (or rebuild, per the note above) the console with these set.

## 2. Repoint Telegram's webhook at the console

Adapt the sidecar-pointed `setWebhook` call (`apps/jace/README.md`'s Channels
section) to the console's route instead:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<host>/api/v1/connectors/telegram/webhook",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

**Downtime-free.** `setWebhook` is a single atomic call — Telegram switches
where it delivers updates in that one request; there's no window where
updates go nowhere. This call is the actual cutover moment.

## 3. What users must do

Existing conversations don't carry over automatically — a chat identity binds
on the first message the shared bot itself receives from that
(platform, platform_user_id) pair (issue #1261). Each person who wants to
keep talking to Jace over Telegram:

1. Opens `https://t.me/<the bot's username>` and sends it any message once —
   this resolves (or creates) their `chat_identities` row.
2. If that identity isn't already bound to this workspace, they complete the
   account-binding flow (issue #1263's magic link) to attach the chat
   identity to their GitHub user + this workspace.

## 4. Rollback

Repoint `setWebhook` back at the sidecar, same shape as `apps/jace/README.md`:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<host>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

Also downtime-free, for the same reason — one atomic `setWebhook` call. The
console's `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET_TOKEN` /
`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` can be left in place or cleared; either
way, nothing in steps 1-3 touched the workspace's own `connectors` row, so
self-host / legacy notify paths that still read it are unaffected.
