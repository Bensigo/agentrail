# Gateways: their own page, off the connectors surface

**Date:** 2026-07-25 · **Status:** approved (owner) · **Branch:** `feat/gateways-page`

## Problem

#1449 turned the connectors page's Gateway section into a chat-first "Channels"
section. Seeing it live, the owner's ruling: **gateways don't belong on the
connectors page at all.** A connector is a tool wired into the factory (GitHub,
Linear feed the Issue Queue; Figma, Context7 give runs tools). A **gateway** is
a place a human talks to Jace — WhatsApp, iMessage, Discord, Slack, Telegram.
Different concept, different page.

Second gap: Discord and Slack have both code halves built but **no app exists**
(prod has `TELEGRAM_*` only), so a user has no way to install them. The page must
make each gateway's real state legible and, where possible, one click away.

## Owner rulings

1. Remove gateways from the connectors page entirely. Connectors = issue sources
   (GitHub, Linear) + MCP (Figma, Context7). Nothing else.
2. Gateways get their own Settings page. **Each row is one action** — Open
   Telegram / Add to Discord / Add to Slack — and the not-yet-real ones are shown
   honestly rather than hidden or faked.
3. Turning Discord/Slack on is portal work the owner does; this page must go live
   the moment the app IDs exist, with no code change.

## Design

### Route + nav

New page `/dashboard/[workspaceId]/gateways`, nav item **Gateways** in
`SETTINGS_ZONE` (`app/components/sidebar-nav.ts`), placed above Connectors,
icon `MessageSquare` (lucide). `sidebar-nav.test.ts` asserts the zone's exact
shape — update it.

### The five gateways

| kind | availability | action when configured | connected state |
|---|---|---|---|
| telegram | available | `Message @<bot> on Telegram` (t.me deep link) | linked identities |
| discord | available | `Add to Discord` (OAuth2 invite URL) | linked identities |
| slack | available | `Add to Slack` (Slack install URL) | linked identities |
| imessage | planned | — | — |
| whatsapp | planned | — | — |

**`available` means the code path exists**, not that it is switched on. Whether
the action renders is a SECOND, env-derived axis (`configured`):

- telegram → `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` (already set in prod)
- discord → `NEXT_PUBLIC_DISCORD_CLIENT_ID` (new; the application id — public,
  not a secret)
- slack → `NEXT_PUBLIC_SLACK_CLIENT_ID` (new; public)

An `available` gateway whose env is unset renders an honest **"Not set up yet"**
line naming what is missing (one short sentence — no setup instructions on this
page; the README owns those). This is what makes ruling 3 work: the owner creates
the app, the client id gets set, the button goes live with no deploy of new code.

`planned` gateways render a **"Coming"** chip and one line of description. No
buttons, no forms, ever.

### Install URL shapes

Built by pure helpers so they are unit-testable, and **verified against the
providers' own current docs by the implementer** (do not trust these sketches
blindly — confirm scopes/params before shipping):

- Discord: `https://discord.com/oauth2/authorize?client_id=<id>&scope=bot+applications.commands&permissions=<n>`
  — the bot must be able to post its async reply, so the permission set must
  include Send Messages. Pin the integer as a named constant with a comment.
- Slack: `https://slack.com/oauth/v2/authorize?client_id=<id>&scope=<bot scopes>`
  — bot scopes matching what the events door needs (`chat:write`, `im:history`,
  `im:read`, `im:write`).

**Known limitation to state in the module doc (not to solve here):** Slack issues
a distinct bot token per installing workspace, while the send path reads one
shared `SLACK_BOT_TOKEN` from env. So the Slack button installs into a workspace,
but only the workspace whose token is in env can actually be replied to. Public
multi-tenant Slack needs an OAuth callback + per-`team_id` token storage — a
separate piece of work, deliberately out of scope. Discord has no such problem
(one bot token serves every guild).

### Connected state

Same spine as #1449: a gateway is connected iff the workspace has ≥1
`chat_identities` row on that platform, surfaced as display names via the
existing `listChatIdentitiesForWorkspace` query and the `linkedIdentitiesLine`
formatter (lifted to a shared module in T1). A connected gateway keeps a quiet
"Open <platform>" link alongside its linked names.

## Task breakdown

- **T1** — `lib/linked-identities.ts` (lift `linkedIdentitiesLine` + its tests out
  of `connector-helpers`, update both importers), plus the new
  `gateways/components/gateway-helpers.ts` pure model (catalog, `configured`
  derivation, install-URL builders, projection from identities) + tests.
- **T2** — `GET /api/v1/workspaces/[workspaceId]/gateways` route + tests: auth +
  membership like the connectors route, returns the projected gateway views.
- **T3** — Page + panel UI + sidebar nav entry + nav test.
- **T4** — Strip channels from the connectors surface: `connector-helpers`
  (drop the `channel` type, the three kinds, `chat` capability,
  `linkedIdentities`, the identities parameter), `connectors-panel`
  (`ChannelManage` gone), page copy back to two groups, and the connectors GET
  route (stop fetching identities). The setup wizard's channel step is NOT
  touched — it keeps onboarding Telegram and now imports the lifted formatter.

## Out of scope (follow-ups)

- Creating the Discord/Slack apps (owner, in the provider portals) and setting the
  two client ids.
- Slack multi-tenant OAuth install + per-workspace token storage.
- WhatsApp (needs a Meta Business number, a channel, and an inbound door) and
  iMessage go-live (needs a paid LoopMessage account).
- `connectorProviderEnum` keeps its telegram/slack/discord values — existing rows
  stay readable and `notify.ts` is untouched.

## Testing

Unit: gateway catalog + projection + install-URL builders + `configured`
derivation; lifted formatter tests; gateways route (auth, membership, shape,
no `platformUserId` leak); connectors projection after the strip; sidebar nav.
Browser (supervisor): both pages render, gateway actions point at real URLs,
connectors shows two groups only.
