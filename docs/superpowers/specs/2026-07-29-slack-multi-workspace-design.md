# Slack multi-workspace install

**Date:** 2026-07-29 · **Status:** draft (owner review) · **Slack app:** `A0BLPG6G78B` (Jace), dev workspace HeyJace `T0BLL0VNR9U`

## Problem

Other teams should be able to install Jace into their own Slack workspace. Today they cannot, and turning it on would be unsafe.

Slack issues a **separate bot token per workspace install**, and a separate bot user id. Discord and Telegram do not work this way — one Discord bot token serves every guild — which is why the "one hosted bot, credentialed by us" model in `2026-07-17-jace-end-to-end-flow-design.md` worked there and does not transfer here.

Three concrete blockers, all verified 2026-07-29:

1. **Outbound is single-tenant.** `apps/console/lib/slack-system-message.ts` reads one `process.env.SLACK_BOT_TOKEN`; its own comment says *"the shared hosted app has exactly one bot token, console-wide"*. jace's `slackChannel()` binds the same single credential at process boot. A second workspace's replies would go nowhere, or worse, somewhere wrong.

2. **Identities collide across workspaces.** `chat_identities` is uniquely keyed `(platform, platform_user_id)`, and the Slack door calls `resolveInboundChatIdentity({platform: "slack", platformUserId: event.user})`. Slack user ids are unique only **within** a workspace, so two people at different companies collide onto one identity row — and identity is what binds a conversation to an AgentRail workspace. This is a cross-tenant data-leak shape, independent of tokens.

3. **Slack itself blocks it.** The Manage Distribution checklist is 3/4 green; the outstanding item is *"remove any hard-coded information from your app, such as OAuth tokens"*. Ticking it today would be a false attestation.

**Nothing to migrate:** prod has zero Slack rows — no `chat_identities` with `platform='slack'`, no `channel_inbox` with `channel='slack'`. This is greenfield, so no backfill.

## Design

### 1. `slack_installations` — one row per Slack team

Modelled on `chat_identities`, not `connectors`. `connectors.workspace_id` is `NOT NULL` with a cascading FK, so it structurally cannot hold an install that happens **before** any AgentRail workspace exists — which is the normal Slack case (someone installs, then connects). `chat_identities` already solves exactly that with a natural key and a nullable workspace.

| Column | Notes |
|---|---|
| `team_id` text, **unique** | Slack's workspace id. The natural key. |
| `team_name` text | Display only. |
| `bot_token` text | Encrypted at rest via the existing `encryptSecret` (AES-256-GCM, `CONNECTOR_SECRET_KEY`, `enc:v1:` format). **No new crypto.** |
| `bot_user_id` text | Per-install. This is what mention detection compares against, replacing the `SLACK_BOT_USER_ID` env var. |
| `installed_by_slack_user_id` text | Who authorized it. |
| `scopes` text | What was granted, for diagnosing a later scope addition. |
| `enterprise_id` text, nullable | Recorded, not supported — see §5. |
| `revoked_at` timestamptz, nullable | Set on `app_uninstalled`; never hard-delete, so an uninstall/reinstall is auditable. |

Migration **`0064`**, journal idx **65**. `0063` is claimed by open PR #1521 — verified, not assumed.

### 2. Install flow

- `GET /api/v1/connectors/slack/install` → 302 to `https://slack.com/oauth/v2/authorize` with `client_id`, `scope`, `redirect_uri`, and a signed `state` (CSRF).
- `GET /api/v1/connectors/slack/callback` → exchange `code` at `oauth.v2.access`, upsert the installation row, land the user on a "connected" page telling them to `/invite @Jace` and mention it.

The `oauth.v2.access` response carries everything needed in one call: `access_token`, `bot_user_id`, `team.id`, `team.name`, `authed_user.id`, `scope`, `is_enterprise_install`.

**Token rotation is deliberately OFF** (`token_rotation_enabled: false` in the app manifest, verified in the dashboard). Slack's rotation is opt-in; with it off a bot token does not expire, so there is no refresh machinery, no single-use refresh-token juggling, and no class of "the app silently died at 12 hours" bug. Revisit as hardening, not now.

### 3. Identity, scoped by team

`resolveInboundChatIdentity` for Slack keys on the **team-scoped** user: `platformUserId = "${team_id}:${user_id}"`.

This is deliberately a string-composition fix rather than a new column, because it needs no change to `chat_identities`' unique index, no change to the other three platforms, and there is no existing Slack data to migrate. The composite is opaque to everything downstream — it is only ever compared, never parsed.

### 4. Outbound moves to the console

jace stops posting to Slack. On `message.completed`, its Slack channel hands the reply back to the console, which resolves the installation by `team_id` and posts with that team's token.

**Why not keep posting from jace.** eve's `botToken` accepts a thunk resolved lazily per API call — so per-install credentials look possible — but the thunk takes **no arguments**, and credentials are bound once at `slackChannel()` construction, process-wide. The only per-turn value that survives is eve's serialized channel state, and `slackChannel().receive()` — the entry point the console uses for every turn — **hardcodes `teamId: null`**, with no field on `SlackReceiveTarget` to pass one. Verified in the installed runtime.

That leaves ambient context as the only route, and it is unsafe here: `turnStep` runs on `@workflow/core`, deserializing context and able to park and resume. A hand-rolled `AsyncLocalStorage` set at webhook time can be **empty or stale** by the time the reply posts — and stale means posting one customer's reply into another customer's Slack. Silent, catastrophic, and exactly the failure this design must not permit.

Moving the post to the console removes the entire class: the team is an explicit argument on an HTTP call, and one place holds tokens. There is precedent — `console_chat_reply.core.mjs` already does this hand-back for the console channel.

**Cost, stated plainly:** eve's native Slack typing indicator and its thread-context helpers stop applying. Threading itself is unaffected — the console posts with `thread_ts`, which is what already makes threads work.

`connectSlackCredentials` is **not** an option: it lives in `@vercel/connect`, an uninstalled package requiring a Vercel account and their provisioning flow. `slack.ts`'s comment calling it "a one-line `credentials:` swap" is wrong and gets corrected.

### 5. Enterprise Grid: refuse, don't guess

Org-wide Grid installs break `team_id` keying — Slack truncates the event `authorizations` array to a single entry and expects a separate API call to enumerate installations.

v1 **rejects** an install where `is_enterprise_install` is true, with a clear message. `org_deploy_enabled` is already `false` in the app manifest. Guessing here means cross-org delivery; refusing means one org sees an honest error.

### 6. What disappears

`SLACK_BOT_TOKEN` and `SLACK_BOT_USER_ID` are removed from the code and from both Railway services. Their presence is what makes Slack's hard-coded-information attestation false.

## Rollout

1. Ship this. 2. Install to HeyJace via the new flow. 3. Set the Event Subscriptions request URL — **only now**, because Slack validates it on save and it must not go live while the code can't tell workspaces apart. 4. Verify a real threaded exchange. 5. Tick the attestation and activate public distribution.

**Bot events (step 3), final whole-branch review, finding #3:** the manifest's Event Subscriptions must list `message.channels`, `message.groups`, `message.im`, `message.mpim` (the message shapes this door already handles) **and `app_uninstalled`** — without it, Slack never tells us a workspace removed the app, `revokeSlackInstallation` (§1) is never called, and an uninstalled workspace's encrypted bot token stays live in `slack_installations` forever (token rotation is off, so it never naturally expires either). The event-handling code for `app_uninstalled` already lands in this PR; this bullet is the one manual dashboard step it depends on — apply it in step 3, at the same time as the request URL.

`SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` are already set on console (2026-07-29). The signing secret is **per-app**, not per-install, so inbound verification needs no change at all.

## Verification

**Unit** — installation upsert and revoke; token encrypt/decrypt round-trip; team-scoped identity key; mention detection against a per-install `bot_user_id`; Enterprise-Grid rejection; the OAuth callback's error paths (declined, expired code, state mismatch).

**Cross-tenant, the one that matters** — two installations with different tokens: a message from team A must resolve A's token and A's identity, and must never see B's. This is the test the whole design exists to pass.

**Prod** — install to HeyJace, mention Jace in a channel, get a threaded reply, confirm one `slack_installations` row and a team-scoped `chat_identities` row.

## Out of scope

- Enterprise Grid org-wide installs (§5).
- Token rotation (§2).
- Slack DM continuity — eve's Slack continuation token is `channelId:threadTs`, so a stable DM session would mean threading every DM reply under one anchor message. Unchanged by this work and still needs its own design.
- Marketplace listing. Public distribution is a separate, lower bar and is all that is needed here.
