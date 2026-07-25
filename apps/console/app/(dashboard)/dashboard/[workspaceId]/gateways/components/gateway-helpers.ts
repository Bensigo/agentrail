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
 * env-derived `configured` axis, and how a gateway's *connected* state
 * derives from the workspace's linked chat identities. This module never
 * reads `process.env` itself — the caller (a Server Component / API route)
 * reads it and passes the values in, the same caller-reads-env split
 * `resolveHostedBotUsername` uses in `apps/console/lib/telegram-bot.ts`.
 *
 * ENV CONTRACT (whole-branch review fix 4): discord/slack reuse the EXACT
 * same env pair the landing page's "also available on" cards already read
 * (`app/(marketing)/_channel-cards.ts`) — an owner-pasted invite/install URL
 * plus an explicit `*_CHANNEL_LIVE` honesty gate — rather than inventing a
 * third encoding of "is this channel set up". An earlier version of this
 * file gated on a bespoke client-id var alone, which let the console claim a
 * channel was live on weaker evidence than the landing page requires; see
 * `_channel-cards.ts`'s HONESTY GATE doc-comment for the rule both surfaces
 * now share. `isTrue` below is a deliberate byte-for-byte duplicate of that
 * file's helper, not an import — this module doesn't reach into the
 * marketing route group, same call as `GatewayIdentity`'s doc-comment below
 * makes re: `connector-helpers.ts`.
 *
 * SLACK SINGLE-TOKEN LIMITATION: the Slack action button (its `actionUrl` is
 * the owner-pasted `NEXT_PUBLIC_SLACK_INSTALL_URL`, verbatim — see
 * `GatewayEnv` below) sends a workspace admin through Slack's own OAuth
 * consent screen and *installs* the Jace app into their workspace, but the
 * send path (`lib/slack-bot.ts`) reads ONE shared `SLACK_BOT_TOKEN` from env
 * — so only the single workspace whose token happens to be in env can
 * actually be replied to. A real public, multi-tenant Slack integration
 * needs an OAuth callback route that exchanges the consent for a token and
 * stores it per `team_id`, then looks that token up per workspace at send
 * time; that callback + storage is deliberately not built here (explicitly
 * out of scope). Discord has no such problem: one bot token/application
 * serves every guild it's invited into.
 */
// Relative (not @/…) because lib/ lives outside app/ or src/, the only roots
// the @/* alias covers — mirrors connectors-panel.tsx's identical import of
// this same module.
import { resolveHostedBotUsername, telegramDeepLink } from "../../../../../../lib/telegram-bot";

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
 * `projectGateways` needs several values instead of one.
 *
 * Discord/slack each get a PAIR, reused verbatim from the landing page's
 * contract (`app/(marketing)/_channel-cards.ts`) rather than a bespoke
 * client-id var — see the module doc-comment's ENV CONTRACT note.
 */
export interface GatewayEnv {
  /** `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — non-blank ⟺ telegram configured. */
  telegramBotUsername: string | undefined;
  /**
   * `NEXT_PUBLIC_DISCORD_INVITE_URL` — the whole invite URL, owner-pasted,
   * same var and same shape the landing page's Discord card reads. On its
   * own this is NOT enough for `configured` — see `discordChannelLive`.
   */
  discordInviteUrl: string | undefined;
  /**
   * `NEXT_PUBLIC_DISCORD_CHANNEL_LIVE` — the landing page's explicit "a real
   * prod conversation has been verified on PROD" gate, reused so the console
   * can never claim Discord is live on weaker evidence than the landing page
   * requires. Must be the literal string `"true"` (`isTrue` below, trimmed +
   * case-insensitive) — anything else, including just having an invite URL,
   * keeps discord unconfigured.
   */
  discordChannelLive: string | undefined;
  /** `NEXT_PUBLIC_SLACK_INSTALL_URL` — see `discordInviteUrl`'s twin above. */
  slackInstallUrl: string | undefined;
  /** `NEXT_PUBLIC_SLACK_CHANNEL_LIVE` — see `discordChannelLive`'s twin above. */
  slackChannelLive: string | undefined;
}

/**
 * Trim + lowercase `"true"` compare. Byte-for-byte the same rule as the
 * landing page's `_channel-cards.ts` `isTrue` (see that file's HONESTY GATE
 * doc-comment) — duplicated rather than imported so this module doesn't
 * reach across into the marketing route group; keep the two in sync by hand
 * if the rule ever changes.
 */
function isTrue(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/**
 * The single env-derived value each gateway's `configured`/`actionUrl`
 * derive from — or `null` if not configured. One resolver so
 * `isGatewayConfigured` (below) and `buildActionUrl` (further down) can never
 * disagree about what counts as "configured": both just ask this.
 *
 * Telegram: non-blank bot username, no live-gate — Telegram was already
 * prod-verified when its own CTA shipped (`_cta.ts`'s
 * `resolveMessageJaceCta` sets this precedent: username-presence alone is
 * enough, #1262/#1263). Discord/Slack: the invite/install URL AND the
 * matching `*ChannelLive` flag must BOTH be set — code-complete is not the
 * same as verified (see the module doc-comment's ENV CONTRACT note), so the
 * URL alone is never enough.
 */
function resolvedGatewayEnvValue(kind: GatewayKind, env: GatewayEnv): string | null {
  switch (kind) {
    case "telegram":
      return resolveHostedBotUsername(env.telegramBotUsername);
    case "discord":
      if (!isTrue(env.discordChannelLive)) return null;
      return env.discordInviteUrl?.trim() || null;
    case "slack":
      if (!isTrue(env.slackChannelLive)) return null;
      return env.slackInstallUrl?.trim() || null;
    case "imessage":
    case "whatsapp":
      // Never configured — they're `planned`, no env var backs them yet.
      return null;
  }
}

/**
 * Whether a gateway's hosted bot/app is set up in this deploy. iMessage and
 * WhatsApp are never configured — they're `planned`, no env var backs them
 * yet. Telegram is gated on its own env var being non-blank; Discord/Slack
 * are gated on their invite/install URL AND their live-verification flag
 * both being set — no other signal (there's no per-workspace credential to
 * check — see the module doc-comment).
 */
export function isGatewayConfigured(kind: GatewayKind, env: GatewayEnv): boolean {
  return resolvedGatewayEnvValue(kind, env) !== null;
}

// --------------------------------------------------------------------------- //
// Action-URL resolution. Telegram's is still built (the deep link, from
// `lib/telegram-bot.ts`'s `telegramDeepLink`, reused as-is rather than
// duplicated); Discord/Slack's is the env URL VERBATIM — the owner pastes
// the whole link (same contract as the landing page), so there is nothing
// left to build in code. The `discordInviteUrl()`/`slackInstallUrl()`
// builder functions that used to live here are deleted along with their
// tests (whole-branch review fix 4) — see the module doc-comment's ENV
// CONTRACT note.
// --------------------------------------------------------------------------- //

function buildActionUrl(kind: GatewayKind, env: GatewayEnv): string | null {
  const value = resolvedGatewayEnvValue(kind, env);
  if (!value) return null;
  switch (kind) {
    case "telegram":
      return telegramDeepLink(value);
    case "discord":
    case "slack":
      return value;
    case "imessage":
    case "whatsapp":
      // Unreachable: resolvedGatewayEnvValue is always null for these, so
      // `value` above would already have returned — kept for exhaustiveness.
      return null;
  }
}

/**
 * Where a CONNECTED gateway's "Open {label}" link should point — distinct
 * from `actionUrl` (whole-branch review fix 1). `actionUrl` is what starts
 * the CONNECT flow: for Telegram that IS a conversation deep link, but for
 * Discord/Slack it's an install/invite URL that reopens the Add-App consent
 * screen, not the conversation — reusing it for "Open Discord" on an
 * already-connected workspace was the bug. Telegram is the only kind with a
 * genuine "reopen this conversation" URL today, so every other kind
 * resolves to `null` here. Do NOT invent an open-link for discord/slack.
 */
function buildOpenUrl(kind: GatewayKind, env: GatewayEnv): string | null {
  if (kind !== "telegram") return null;
  return buildActionUrl(kind, env);
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
  /**
   * Where a CONNECTED gateway's "Open {label}" link should point — `null`
   * unless this kind has a genuine reopen-the-conversation URL (see
   * `buildOpenUrl`). Telegram only, today. Never fall back to `actionUrl`
   * for this on discord/slack: it's an install link, not a way back into
   * the chat (whole-branch review fix 1).
   */
  openUrl: string | null;
  /** That platform's linked identities (`[]` otherwise) — populated regardless of availability, mirroring `projectConnectors`. */
  linkedIdentities: { displayName: string | null }[];
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
    const canAct = entry.availability === "available" && configured;
    const actionUrl = canAct ? buildActionUrl(entry.kind, env) : null;
    const openUrl = canAct ? buildOpenUrl(entry.kind, env) : null;

    return {
      kind: entry.kind,
      label: entry.label,
      description: entry.description,
      availability: entry.availability,
      status,
      configured,
      actionUrl,
      openUrl,
      linkedIdentities: kindIdentities.map((identity) => ({
        displayName: identity.displayName,
      })),
    };
  });
}
