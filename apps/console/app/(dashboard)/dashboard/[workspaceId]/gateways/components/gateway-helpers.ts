/**
 * Pure model for the **Gateways** settings surface (gateways-page T1).
 *
 * A **gateway** is where a human talks to Jace — Telegram, Discord, Slack,
 * iMessage, WhatsApp — as distinct from a **connector** (GitHub/Linear/Figma/
 * Context7: tools wired into the factory, CONTEXT.md/ADR 0010). Gateways used
 * to be filed as the connector catalog's `channel` group; the owner ruled
 * them onto their own Settings page instead, so this module starts a fresh,
 * gateway-only catalog rather than reusing `connector-helpers.ts`'s (which
 * loses its channel group entirely once the gateways page ships — T4).
 *
 * Like `connector-helpers.ts`'s `projectConnectors`, this is the pure
 * projection the page reads (no I/O, unit-testable): the catalog, the
 * env-derived `configured` axis, the per-platform install-URL builders, and
 * how a gateway's *connected* state derives from the workspace's linked chat
 * identities. This module never reads `process.env` itself — the caller
 * (a Server Component / API route) reads it and passes the values in, the
 * same caller-reads-env split `resolveHostedBotUsername` uses in
 * `apps/console/lib/telegram-bot.ts`.
 *
 * SLACK SINGLE-TOKEN LIMITATION: `slackInstallUrl`'s button sends a workspace
 * admin through Slack's own OAuth consent screen and *installs* the Jace app
 * into their workspace, but the send path (`lib/slack-bot.ts`) reads ONE
 * shared `SLACK_BOT_TOKEN` from env — so only the single workspace whose
 * token happens to be in env can actually be replied to. A real public,
 * multi-tenant Slack integration needs an OAuth callback route that exchanges
 * the consent for a token and stores it per `team_id`, then looks that token
 * up per workspace at send time; that callback + storage is deliberately not
 * built here. Discord has no such problem: one bot token/application serves
 * every guild it's invited into, so `discordInviteUrl` has no equivalent
 * caveat.
 */
// Relative (not @/…) because lib/ lives outside app/ or src/, the only roots
// the @/* alias covers — mirrors connectors-panel.tsx's identical import of
// this same module.
import { telegramDeepLink } from "../../../../../../lib/telegram-bot";

/** The five chat surfaces a human can reach Jace through. */
export type GatewayKind =
  | "telegram"
  | "discord"
  | "slack"
  | "imessage"
  | "whatsapp";

/** Whether a gateway's adapter is implemented today, vs. planned. */
export type GatewayAvailability = "available" | "planned";

/** A gateway's connection state on this workspace. */
export type GatewayStatus = "connected" | "disconnected";

/** Static catalog entry for a gateway kind — no credential metadata of any kind (nothing is pasted to add a gateway; see the module doc-comment). */
export interface GatewayCatalogEntry {
  kind: GatewayKind;
  label: string;
  description: string;
  availability: GatewayAvailability;
}

/**
 * The gateway catalog, in render order: Telegram, Discord, Slack (all
 * `available` — each has a hosted shared-bot/app already wired, see
 * `lib/telegram-bot.ts`, `lib/discord-bot.ts`, `lib/slack-bot.ts`), then
 * iMessage, WhatsApp (both `planned` — no adapter yet).
 */
export const GATEWAY_CATALOG: GatewayCatalogEntry[] = [
  {
    kind: "telegram",
    label: "Telegram",
    description: "Chat with Jace in a Telegram DM.",
    availability: "available",
  },
  {
    kind: "discord",
    label: "Discord",
    description: "Chat with Jace in your Discord server.",
    availability: "available",
  },
  {
    kind: "slack",
    label: "Slack",
    description: "Chat with Jace in Slack.",
    availability: "available",
  },
  {
    kind: "imessage",
    label: "iMessage",
    description: "Chat with Jace from Messages.",
    availability: "planned",
  },
  {
    kind: "whatsapp",
    label: "WhatsApp",
    description: "Chat with Jace on WhatsApp.",
    availability: "planned",
  },
];

/**
 * The raw env values the `configured` axis derives from. The caller reads
 * `process.env` (Server Component / API route) and passes this bag in — this
 * module never reads env itself, mirroring `telegram-bot.ts`'s
 * `resolveHostedBotUsername(raw)` split, just bundled into one object since
 * `projectGateways` needs three values instead of one.
 */
export interface GatewayEnv {
  /** `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — non-blank ⟺ telegram configured. */
  telegramBotUsername: string | undefined;
  /** `NEXT_PUBLIC_DISCORD_CLIENT_ID` — non-blank ⟺ discord configured. */
  discordClientId: string | undefined;
  /** `NEXT_PUBLIC_SLACK_CLIENT_ID` — non-blank ⟺ slack configured. */
  slackClientId: string | undefined;
}

/**
 * The single env value each gateway's `configured`/`actionUrl` derive from,
 * trimmed — or `null` if blank/unset/not applicable. One resolver so
 * `isGatewayConfigured` (below) and `buildActionUrl` (further down) can never
 * disagree about what counts as "configured": both just ask this.
 */
function resolvedGatewayEnvValue(kind: GatewayKind, env: GatewayEnv): string | null {
  switch (kind) {
    case "telegram":
      return env.telegramBotUsername?.trim() || null;
    case "discord":
      return env.discordClientId?.trim() || null;
    case "slack":
      return env.slackClientId?.trim() || null;
    case "imessage":
    case "whatsapp":
      // Never configured — they're `planned`, no env var backs them yet.
      return null;
  }
}

/**
 * Whether a gateway's hosted bot/app is set up in this deploy. iMessage and
 * WhatsApp are never configured — they're `planned`, no env var backs them
 * yet. Telegram/Discord/Slack are each gated on their own single env var
 * being non-blank; no other signal (there's no per-workspace credential to
 * check — see the module doc-comment).
 */
export function isGatewayConfigured(kind: GatewayKind, env: GatewayEnv): boolean {
  return resolvedGatewayEnvValue(kind, env) !== null;
}

// --------------------------------------------------------------------------- //
// Install-URL builders — pure, one per platform, taking the already-resolved
// id. `telegramDeepLink` (the Telegram equivalent) already exists in
// `lib/telegram-bot.ts` and is reused as-is by `projectGateways` below rather
// than duplicated here.
// --------------------------------------------------------------------------- //

/**
 * Discord permission bitfield this invite grants: SEND_MESSAGES only
 * (`1 << 11` = decimal 2048 / hex 0x800) — the minimum the hosted bot needs
 * to post Jace's async reply (`lib/discord-bot.ts`'s
 * `sendDiscordChannelMessage` posts via `POST /channels/{id}/messages`).
 * Confirmed against Discord's permissions bitwise-flags table,
 * https://discord.com/developers/docs/topics/permissions (canonical
 * docs.discord.com/developers/topics/permissions since Discord's doc-site
 * migration), checked 2026-07-25: SEND_MESSAGES is listed at bit `1 << 11`.
 */
/**
 * Discord's install URL for the Jace app — DELIBERATELY the bare
 * `?client_id=` form, with NO `scope=` / `permissions=` query parameters.
 *
 * This is the "Discord Provided Link" the Developer Portal's Installation tab
 * shows verbatim, and it is not merely a shorter equivalent of a hand-built
 * invite URL. The two behave differently:
 *
 *  - Bare link  → Discord's modern Add-App flow, which reads the app's
 *    **Default Install Settings** and offers BOTH install contexts: user
 *    install ("Try it now" — Jace lives on the user's account and is usable
 *    in any DM, no server required) and guild install ("Add to Server").
 *  - `scope=`/`permissions=` link → the legacy guild-only bot-invite flow.
 *    It pins the request to those literal params and drops the user-install
 *    path entirely, so anyone without their own server has no way in.
 *
 * Since the whole point of a gateway is "click it and start talking", losing
 * user install would be a real regression — hence the bare form. Scopes and
 * permissions are therefore owned by the PORTAL, not by this code: the Jace
 * app is configured (verified in-portal 2026-07-25) with guild install =
 * `applications.commands` + `bot` + Send Messages, and user install =
 * `applications.commands`. The `bot` scope + Send Messages matter because
 * Jace's real answer is posted separately through the Bot API
 * (`sendDiscordChannelMessage` → `POST /channels/{id}/messages`); without
 * them the interaction ack still appears and the actual reply never lands.
 *
 * Keep this in sync with the portal, not with a constant here: changing the
 * granted scopes is a portal edit, and this URL needs no code change for it.
 */
export function discordInviteUrl(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(
    clientId
  )}`;
}

/**
 * The bot scopes the shared Slack app's Events API door needs: `chat:write`
 * to post Jace's reply (`lib/slack-bot.ts`'s `sendSlackChannelMessage`),
 * `im:history`/`im:read`/`im:write` to read and open the DM conversation the
 * events webhook resolves (`app/api/v1/connectors/slack/events/route.ts`).
 */
const SLACK_BOT_SCOPES = ["chat:write", "im:history", "im:read", "im:write"];

/**
 * Slack's OAuth v2 "Add to Slack" URL that installs the shared app into a
 * workspace. See the module doc-comment's SLACK SINGLE-TOKEN LIMITATION: this
 * only starts Slack's own consent screen — no callback route captures the
 * resulting per-workspace token here, so completing it doesn't make a new
 * workspace actually reachable yet.
 *
 * Shape confirmed against Slack's OAuth v2 docs,
 * https://docs.slack.dev/authentication/installing-with-oauth (api.slack.com/
 * authentication/oauth-v2 redirects here), checked 2026-07-25: base
 * `https://slack.com/oauth/v2/authorize`, bot scopes in `scope` as a
 * comma-separated list (the docs' own example: `scope=incoming-webhook,
 * commands`). `:` and `,` are left unescaped — both are valid unencoded in a
 * URI query component (RFC 3986 pchar / sub-delims) and match the docs'
 * literal example shape. No `redirect_uri` is passed: this build never
 * exchanges the resulting code (see the limitation above), so there is
 * nothing for a redirect to hand off to.
 */
export function slackInstallUrl(clientId: string): string {
  return `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(
    clientId
  )}&scope=${SLACK_BOT_SCOPES.join(",")}`;
}

// --------------------------------------------------------------------------- //
// Projection
// --------------------------------------------------------------------------- //

/**
 * A workspace's linked chat identity for one platform, as `projectGateways`
 * consumes it. Deliberately NOT imported from `connector-helpers.ts`'s
 * `ChannelIdentity` (same `{platform, displayName}` shape) — that module's
 * channel group is retired by T4 once the gateways page ships, so importing
 * across surfaces here would just create a dependency this module would need
 * to unwind later. Defined locally instead; `platform` stays a bare `string`
 * to match `chat_identities`' actual column type (packages/db-postgres).
 */
export interface GatewayIdentity {
  platform: string;
  displayName: string | null;
}

/** One gateway row as the settings surface renders it. */
export interface GatewayView {
  kind: GatewayKind;
  label: string;
  description: string;
  availability: GatewayAvailability;
  status: GatewayStatus;
  /** Whether this deploy's env has the hosted bot/app for this gateway set up. */
  configured: boolean;
  /**
   * Where to send the user to connect this gateway (open the deep link /
   * start the OAuth install) — non-null ONLY for an `available` gateway that
   * is also `configured` (an unconfigured or `planned` gateway has nothing to
   * send anyone to).
   */
  actionUrl: string | null;
  /** That platform's linked identities (`[]` otherwise) — populated regardless of availability, mirroring `projectConnectors`. */
  linkedIdentities: { displayName: string | null }[];
}

function buildActionUrl(kind: GatewayKind, env: GatewayEnv): string | null {
  const value = resolvedGatewayEnvValue(kind, env);
  if (!value) return null;
  switch (kind) {
    case "telegram":
      return telegramDeepLink(value);
    case "discord":
      return discordInviteUrl(value);
    case "slack":
      return slackInstallUrl(value);
    case "imessage":
    case "whatsapp":
      // Unreachable: resolvedGatewayEnvValue is always null for these, so
      // `value` above would already have returned — kept for exhaustiveness.
      return null;
  }
}

/**
 * Project the catalog against the workspace's linked chat identities into the
 * rows the gateways page renders. Pure and total: a kind with no linked
 * identity is `disconnected`; only an `available` gateway with ≥1 linked
 * identity of its platform shows `connected` (mirrors `projectConnectors`'s
 * availability gate — a `planned` kind never connects even with a matching
 * identity already on file).
 */
export function projectGateways(
  identities: GatewayIdentity[],
  env: GatewayEnv
): GatewayView[] {
  const identitiesByPlatform = new Map<string, GatewayIdentity[]>();
  for (const identity of identities) {
    const existing = identitiesByPlatform.get(identity.platform);
    if (existing) existing.push(identity);
    else identitiesByPlatform.set(identity.platform, [identity]);
  }

  return GATEWAY_CATALOG.map((entry) => {
    const kindIdentities = identitiesByPlatform.get(entry.kind) ?? [];
    const configured = isGatewayConfigured(entry.kind, env);
    const status: GatewayStatus =
      entry.availability === "available" && kindIdentities.length > 0
        ? "connected"
        : "disconnected";
    const actionUrl =
      entry.availability === "available" && configured
        ? buildActionUrl(entry.kind, env)
        : null;

    return {
      kind: entry.kind,
      label: entry.label,
      description: entry.description,
      availability: entry.availability,
      status,
      configured,
      actionUrl,
      linkedIdentities: kindIdentities.map((identity) => ({
        displayName: identity.displayName,
      })),
    };
  });
}
