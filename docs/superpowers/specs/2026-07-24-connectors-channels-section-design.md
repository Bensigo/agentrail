# Connectors page: Gateway → Channels cutover

**Date:** 2026-07-24 · **Status:** approved (owner) · **Branch:** `feat/connectors-channels-section`

## Problem

The connectors page's **Gateway** section predates Jace's native channels and now
contradicts the chat-first flow:

- The **Telegram** card asks users to create a BotFather bot and paste its token +
  chat id — but the product's flow is "DM the shared bot" (`t.me/<bot>`), which the
  setup wizard (#1262) and the landing CTA already use. Telegram should send users
  to the direct chat.
- The **Slack** card collects an incoming-webhook URL that **nothing consumes**
  (`notify.ts` — Slack is greenfield/Jace-only; no legacy sender exists). Dead form.
- The **Discord** card collects a workspace webhook for the legacy notify path.
- Meanwhile the real chat doors — shared Telegram bot (#1262), Discord app (#1284),
  Slack app (#1285), all resolving `chat_identities` — have no management surface.

## Owner rulings (recorded from the design conversation)

1. Scope: the whole Gateway section (Telegram, Slack, Discord).
2. Replacement: a slim **Channels** section stays on the connectors page.
3. Self-host: **docs only** — no BYO credential forms anywhere in the UI.
4. No production users → remove BYO surfaces outright; no migration path needed.
5. **No notify work in this change.** `notify.ts`, the `jaceOwns*` flags, and the
   legacy sender modules stay byte-for-byte untouched (dormant). Page copy makes no
   notification promises. Spine-based notify targeting is a follow-up for when
   there are users.

## Design

### Page IA

Sections: **Issue sources** (GitHub, Linear — unchanged) → **MCP** (Figma,
Context7 — unchanged) → **Channels** (renamed from Gateway). Heartbeat header and
trigger controls are ingest-only and unchanged.

`CONNECTOR_TYPE_META.channel`: label "Channels", description ≈ "Where you and your
team talk to Jace. Message the bot once — that conversation becomes your channel."
(Chat-focused; no notify language.)

### Channels cards

- **Telegram — `available`.**
  - Disconnected: one line of copy + accent CTA "Message @{bot} on Telegram" via the
    shared `resolveHostedBotUsername`/`telegramDeepLink` helpers
    (`apps/console/lib/telegram-bot.ts`, env `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`).
    Env unset (self-host): a one-line docs pointer (`SELF_HOST_TELEGRAM_DOCS_URL`)
    instead of a dead button. No forms.
  - Connected = the workspace has ≥1 linked Telegram chat identity. Show linked
    display names (fallback "1 linked" when null) + keep an "Open Telegram" link.
- **Discord, Slack — `planned`**, "Coming" chip. No forms, no fake states.
- **iMessage:** absent until the bridge exists.
- Card subtitle: channels get capability `chat: true` (new optional field on
  `ConnectorCapabilities`); `capabilitySummary` renders it as "Chat". Channel kinds
  drop `ingest/postResult/notify` display entirely.

### Data & API contract

- **New query** (`@agentrail/db-postgres`): `listChatIdentitiesForWorkspace(workspaceId)`
  → `{ platform, platformUserId, displayName }[]` from `chat_identities` where
  `workspace_id` matches. Read-only; mirror the existing query-module + test style
  (`queries/chat_identities.ts`, pglite harness).
- **Connectors GET route** (`workspaces/[workspaceId]/connectors/route.ts`):
  - stops projecting slack/telegram secret + discord webhook state;
  - calls the new query and returns, per channel-kind view,
    `linkedIdentities: { displayName: string | null }[]` (empty array for
    non-channel kinds).
- **`projectConnectors(configs, identities)`** takes the identity list as a second
  argument; a channel kind is `connected` iff ≥1 identity of its platform.
  `ConnectorView` gains `linkedIdentities`; loses `chatId`, `connect` for channel
  kinds (see removals).

### Removals (exact)

UI (`connectors/components/`):
- `DiscordManage`, gateway branches of `SecretManage` (component keeps serving
  linear/figma/context7), the chat-id input + `needsChatId`.
- Catalog: `ConnectorType` `"gateway"` → `"channel"`; telegram/slack/discord lose
  `connect` meta (`credential*`, `setupSteps`, `helpUrl`); telegram `available`,
  discord/slack `planned`.
- Helpers: telegram/slack/discord branches of `validateConnectorCredential`;
  `isTelegramToken`, `isTelegramChatId`, `isSlackWebhook`, `maskWebhook` (verify no
  remaining importers; `channel-step.tsx` loses its import in T5).
- `ConnectorView.chatId` and the telegram/webhook `target` derivation.

API routes (`app/api/v1/workspaces/[workspaceId]/connectors/`):
- `discord/` route (webhook PUT) — delete the directory.
- `secret/route.ts` allowlist drops `slack` + `telegram` (keeps linear/figma/context7).
- `secret/verify.ts` telegram/slack cases + the telegram live probe.
- **KEEP** `secret/telegram.ts` and `secret/discord.ts` module files: `notify.ts`
  imports their senders (ruling 5 — notify untouched). Only their *callers* in the
  connect path go away.

Setup wizard:
- `channel-step.tsx`: BYO form branch (env-unset path) → docs pointer + Skip;
  hosted deep-link branch stays; drop `validateConnectorCredential` import; the
  connected state shows linked names instead of `chatId`.
- `lib/onboarding-data.ts`: `channelConnected` flips from
  `Boolean(telegramConnector?.hasSecret)` to "≥1 linked telegram identity" via the
  new query. `channelSkippedAt` mechanism stays.

**Do NOT touch:** `app/api/v1/connectors/{telegram,discord,slack,github,jace,linear}/`
(shared-bot inbound doors), `notify.ts`, `jaceOwns*` helpers/config fields,
db `connectorProviderEnum`, any schema/migration.

### Out of scope / follow-ups

- Spine-based notify targeting (when there are users).
- Discord invite / Slack install affordances (per-channel follow-ups once the
  hosted apps are publicly reachable).
- Dropping the dead `discord_webhook_url` column / secret rows (needs migration).

## Task breakdown (subagent waves)

Wave 1 (parallel, disjoint files):
- **T1** db-postgres: `listChatIdentitiesForWorkspace` + query test.
- **T2** `connector-helpers.ts` + its test: catalog/type/capability/removal rework,
  `projectConnectors(configs, identities)`.

Coordination: after wave 1, supervisor rebuilds `@agentrail/db-postgres` dist
(workspace staleness) before wave 2 typechecks.

Wave 2 (parallel, disjoint files, both implement the spec'd contract):
- **T3** `connectors-panel.tsx` + `page.tsx`: Channels cards, deep-link CTA,
  linked-names state, remove dead manage components; page intro copy.
- **T4** routes: GET projection + linked identities; secret allowlist trim;
  verify.ts trim; delete discord route dir.
- **T5** wizard: `channel-step.tsx` + helpers test, `onboarding-data.ts` signal flip.

Supervisor: review each wave's diff, run package tests + console typecheck/lint,
browser-verify the page via minted dev session (CI skips console tests), open PR.

## Testing

- Unit: helpers projection (catalog shape, connected-from-identities, removals),
  new query test, channel-step helpers, onboarding-data signal.
- Browser (supervisor): connectors page renders 3 sections; Telegram card deep-links
  and shows linked state; no credential inputs anywhere on channel cards; issue
  sources/MCP unchanged; wizard channel step still renders both branches.
