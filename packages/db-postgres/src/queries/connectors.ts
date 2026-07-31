import { eq, and, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../db.js";
import { encryptSecret, decryptSecret } from "../crypto.js";
import {
  connectors,
  connectorProviderEnum,
  CONNECTOR_CONFIG_DEFAULTS,
  type ConnectorConfig,
  type ConnectorProvider,
  type ConnectorRowView,
} from "../schema/connectors.js";

/** Poll-interval bounds (seconds). Below 10s hammers the upstream API; a day is
 * the sane upper bound for a "heartbeat". */
export const MIN_POLL_INTERVAL_SECONDS = 10;
export const MAX_POLL_INTERVAL_SECONDS = 86_400;

/** A partial update to a connector row (enabled and/or trigger config). */
export interface ConnectorUpdate {
  enabled?: boolean;
  config?: Partial<ConnectorConfig>;
}

/** Is `value` a known connector provider? */
export function isConnectorProvider(value: unknown): value is ConnectorProvider {
  return (
    typeof value === "string" &&
    (connectorProviderEnum as readonly string[]).includes(value)
  );
}

/**
 * Shared validation for a simple optional string config field — the same
 * "must be a string, trim, non-empty, bounded length" shape `railwayProjectId`
 * established (Task 7) below, reused for Evidence Providers Wave 2's ten
 * non-secret companion fields (Task P0 — `langfuseHost`, `sentryOrg`, …) so
 * eleven near-identical blocks don't each hand-roll the same three checks.
 * `maxLength` defaults to 256 — generous enough for the short id/name-shaped
 * fields (`sentryOrg`, `datadogSite`, `vercelTeamId`, …); none of these
 * values are ever rendered back at length, only stored and read by an
 * adapter. The wave's three URL-shaped fields (`langfuseHost`,
 * `prometheusUrl`, `grafanaUrl`) additionally need a scheme gate — see the
 * sibling {@link validateUrlConfigString} (Fix Round 1) immediately below,
 * which builds on this one rather than duplicating it.
 */
function validateSimpleConfigString(
  value: unknown,
  fieldName: string,
  maxLength = 256
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") {
    return { ok: false, error: `${fieldName} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${fieldName} must not be empty` };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, error: `${fieldName} must be at most ${maxLength} characters` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Sibling to {@link validateSimpleConfigString} for the wave's three
 * URL-shaped fields (`langfuseHost`, `prometheusUrl`, `grafanaUrl`) — Fix
 * Round 1: this is the centralization Task P0 exists for, so P2/P5/P6 never
 * each re-derive it. Must parse via `new URL()` and the scheme must be
 * `http:` or `https:`; everything else about `validateSimpleConfigString`
 * (trim, ≤256 chars) still applies.
 *
 * SSRF tradeoff, deliberate: this gates the SCHEME only, never the HOST.
 * `javascript:`, `file:`, `data:`, and similar non-HTTP schemes have no
 * business being handed to a bearer-token `fetch()` call and are rejected
 * outright. Private/internal hosts (`http://prometheus.internal:9090`,
 * `http://10.0.0.5:3000`, `localhost`, …) are DELIBERATELY ALLOWED — a
 * self-hosted Prometheus, Grafana, or Langfuse instance is legitimately
 * reachable only from inside the operator's own network, and the runner
 * that will eventually query it (P2/P5/P6's adapters) is expected to run
 * with that same network access. Blocking private hosts here would make
 * the self-hosted case this wave explicitly supports (see
 * `plan-providers.md`'s P2 "or self-host" and P5's pinned scope) impossible
 * to configure at all. This is a scheme allowlist, not a network boundary —
 * it narrows "what shape of string is even worth storing," nothing more.
 */
function validateUrlConfigString(
  value: unknown,
  fieldName: string,
  maxLength = 256
): { ok: true; value: string } | { ok: false; error: string } {
  const simple = validateSimpleConfigString(value, fieldName, maxLength);
  if (!simple.ok) return simple;

  let parsed: URL;
  try {
    parsed = new URL(simple.value);
  } catch {
    return { ok: false, error: `${fieldName} must be a valid URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `${fieldName} must be an http:// or https:// URL` };
  }
  return { ok: true, value: simple.value };
}

/**
 * Validate a connector update. Pure — no I/O. Returns the normalized fields to
 * persist, or an error message. The route and the read model both rely on this
 * being the single source of truth for what is a legal connector config.
 */
export function validateConnectorUpdate(
  update: ConnectorUpdate
):
  | { ok: true; value: ConnectorUpdate }
  | { ok: false; error: string } {
  const value: ConnectorUpdate = {};

  if (update.enabled !== undefined) {
    if (typeof update.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    value.enabled = update.enabled;
  }

  if (update.config !== undefined) {
    const cfg = update.config;
    if (typeof cfg !== "object" || cfg === null) {
      return { ok: false, error: "config must be an object" };
    }
    const out: Partial<ConnectorConfig> = {};

    if (cfg.pollIntervalSeconds !== undefined) {
      const n = cfg.pollIntervalSeconds;
      if (typeof n !== "number" || !Number.isInteger(n)) {
        return { ok: false, error: "pollIntervalSeconds must be an integer" };
      }
      if (n < MIN_POLL_INTERVAL_SECONDS || n > MAX_POLL_INTERVAL_SECONDS) {
        return {
          ok: false,
          error: `pollIntervalSeconds must be between ${MIN_POLL_INTERVAL_SECONDS} and ${MAX_POLL_INTERVAL_SECONDS}`,
        };
      }
      out.pollIntervalSeconds = n;
    }

    if (cfg.triggerLabel !== undefined) {
      if (typeof cfg.triggerLabel !== "string") {
        return { ok: false, error: "triggerLabel must be a string" };
      }
      const trimmed = cfg.triggerLabel.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "triggerLabel must not be empty" };
      }
      if (trimmed.length > 50) {
        return {
          ok: false,
          error: "triggerLabel must be at most 50 characters",
        };
      }
      out.triggerLabel = trimmed;
    }

    if (cfg.repos !== undefined) {
      if (
        !Array.isArray(cfg.repos) ||
        cfg.repos.some((r) => typeof r !== "string")
      ) {
        return { ok: false, error: "repos must be an array of strings" };
      }
      out.repos = cfg.repos.map((r) => r.trim()).filter((r) => r.length > 0);
    }

    if (cfg.chatId !== undefined) {
      if (typeof cfg.chatId !== "string") {
        return { ok: false, error: "chatId must be a string" };
      }
      const trimmed = cfg.chatId.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "chatId must not be empty" };
      }
      if (trimmed.length > 64) {
        return { ok: false, error: "chatId must be at most 64 characters" };
      }
      out.chatId = trimmed;
    }

    // Jace channel-migration opt-in (#1047). The per-workspace cutover control:
    // set true on the `jace` connector to route OUTBOUND Telegram notify through
    // Jace. Validated here so the operator can flip it via the connector PATCH
    // route; default OFF, so absence keeps the legacy notify path.
    if (cfg.telegramNotify !== undefined) {
      if (typeof cfg.telegramNotify !== "boolean") {
        return { ok: false, error: "telegramNotify must be a boolean" };
      }
      out.telegramNotify = cfg.telegramNotify;
    }

    // Jace channel-migration opt-ins for Discord + Slack (#1050) — same shape as
    // telegramNotify above: booleans on the `jace` row that flip each channel's
    // OUTBOUND notify source to Jace. Validated here so the operator can flip them
    // via the connector PATCH route; default OFF, so absence keeps the legacy path
    // (Discord) / no notification (Slack, greenfield).
    if (cfg.discordNotify !== undefined) {
      if (typeof cfg.discordNotify !== "boolean") {
        return { ok: false, error: "discordNotify must be a boolean" };
      }
      out.discordNotify = cfg.discordNotify;
    }

    if (cfg.slackNotify !== undefined) {
      if (typeof cfg.slackNotify !== "boolean") {
        return { ok: false, error: "slackNotify must be a boolean" };
      }
      out.slackNotify = cfg.slackNotify;
    }

    // Jace channel-migration opt-in for iMessage (#1100) — same shape as the
    // channels above: a boolean on the `jace` row that turns ON Jace-side iMessage
    // notify. iMessage is greenfield (bridge-only, no legacy path), so absence
    // means no notification. Validated here so the operator can flip it via the
    // connector PATCH route; default OFF.
    if (cfg.imessageNotify !== undefined) {
      if (typeof cfg.imessageNotify !== "boolean") {
        return { ok: false, error: "imessageNotify must be a boolean" };
      }
      out.imessageNotify = cfg.imessageNotify;
    }

    // Railway evidence connector (Task 7): the workspace's Railway project
    // id, saved via this same PATCH route alongside (not instead of) the
    // secret PUT — see the schema doc-comment on
    // ConnectorConfig.railwayProjectId. Same validation shape as chatId
    // above (trim, non-empty, bounded length).
    if (cfg.railwayProjectId !== undefined) {
      if (typeof cfg.railwayProjectId !== "string") {
        return { ok: false, error: "railwayProjectId must be a string" };
      }
      const trimmed = cfg.railwayProjectId.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "railwayProjectId must not be empty" };
      }
      if (trimmed.length > 64) {
        return { ok: false, error: "railwayProjectId must be at most 64 characters" };
      }
      out.railwayProjectId = trimmed;
    }

    // Evidence Providers Wave 2 (Task P0): the wave's ten non-secret
    // companion fields, added ALL AT ONCE so P2-P8 never touch this
    // package again — see the schema doc-comment on each field
    // (`schema/connectors.ts`'s `ConnectorConfig`). Same
    // trim/non-empty/bounded-length shape as `railwayProjectId` above, via
    // the shared `validateSimpleConfigString` helper — EXCEPT the three
    // URL-shaped fields (langfuseHost, prometheusUrl, grafanaUrl below),
    // which are scheme-gated via `validateUrlConfigString` instead (Fix
    // Round 1 — see that function's own doc-comment for the SSRF-tradeoff
    // reasoning).
    if (cfg.langfuseHost !== undefined) {
      const r = validateUrlConfigString(cfg.langfuseHost, "langfuseHost");
      if (!r.ok) return r;
      out.langfuseHost = r.value;
    }
    if (cfg.sentryOrg !== undefined) {
      const r = validateSimpleConfigString(cfg.sentryOrg, "sentryOrg");
      if (!r.ok) return r;
      out.sentryOrg = r.value;
    }
    if (cfg.sentryProject !== undefined) {
      const r = validateSimpleConfigString(cfg.sentryProject, "sentryProject");
      if (!r.ok) return r;
      out.sentryProject = r.value;
    }
    if (cfg.datadogSite !== undefined) {
      const r = validateSimpleConfigString(cfg.datadogSite, "datadogSite");
      if (!r.ok) return r;
      out.datadogSite = r.value;
    }
    if (cfg.prometheusUrl !== undefined) {
      const r = validateUrlConfigString(cfg.prometheusUrl, "prometheusUrl");
      if (!r.ok) return r;
      out.prometheusUrl = r.value;
    }
    if (cfg.grafanaUrl !== undefined) {
      const r = validateUrlConfigString(cfg.grafanaUrl, "grafanaUrl");
      if (!r.ok) return r;
      out.grafanaUrl = r.value;
    }
    if (cfg.vercelTeamId !== undefined) {
      const r = validateSimpleConfigString(cfg.vercelTeamId, "vercelTeamId");
      if (!r.ok) return r;
      out.vercelTeamId = r.value;
    }
    if (cfg.vercelProjectId !== undefined) {
      const r = validateSimpleConfigString(cfg.vercelProjectId, "vercelProjectId");
      if (!r.ok) return r;
      out.vercelProjectId = r.value;
    }
    if (cfg.cloudflareZoneId !== undefined) {
      const r = validateSimpleConfigString(cfg.cloudflareZoneId, "cloudflareZoneId");
      if (!r.ok) return r;
      out.cloudflareZoneId = r.value;
    }
    if (cfg.cloudflareAccountId !== undefined) {
      const r = validateSimpleConfigString(cfg.cloudflareAccountId, "cloudflareAccountId");
      if (!r.ok) return r;
      out.cloudflareAccountId = r.value;
    }

    value.config = out;
  }

  return { ok: true, value };
}

/** Merge a stored / partial config over the defaults into a complete config. */
function completeConfig(stored: Partial<ConnectorConfig> | null | undefined): ConnectorConfig {
  return {
    repos: stored?.repos ?? CONNECTOR_CONFIG_DEFAULTS.repos,
    triggerLabel: stored?.triggerLabel ?? CONNECTOR_CONFIG_DEFAULTS.triggerLabel,
    pollIntervalSeconds:
      stored?.pollIntervalSeconds ??
      CONNECTOR_CONFIG_DEFAULTS.pollIntervalSeconds,
    // Optional telegram chat id — only present when stored.
    ...(stored?.chatId ? { chatId: stored.chatId } : {}),
    // Optional discord/slack Jace-native channel target (#1050) — only present
    // when stored; preserved across merges like chatId so a later config patch
    // (e.g. re-saving the Discord webhook) never strips a resolved channelId.
    ...(stored?.channelId ? { channelId: stored.channelId } : {}),
    // Optional telegram inbound webhook secret (#889) — preserved across merges
    // so a later config patch (e.g. label edit) never strips the inbound auth.
    ...(stored?.webhookSecret ? { webhookSecret: stored.webhookSecret } : {}),
    // Jace channel-migration opt-in (#1047) — preserved across merges so a later
    // config patch (e.g. label edit on the jace row) never silently reverts the
    // Telegram-notify cutover for the workspace.
    ...(typeof stored?.telegramNotify === "boolean"
      ? { telegramNotify: stored.telegramNotify }
      : {}),
    // Jace channel-migration opt-ins for Discord + Slack (#1050) — preserved
    // across merges for the same reason: a later partial config patch must never
    // silently revert a channel's cutover.
    ...(typeof stored?.discordNotify === "boolean"
      ? { discordNotify: stored.discordNotify }
      : {}),
    ...(typeof stored?.slackNotify === "boolean"
      ? { slackNotify: stored.slackNotify }
      : {}),
    // Jace channel-migration opt-in for iMessage (#1100) — preserved across merges
    // for the same reason: a later partial config patch must never silently revert
    // the channel's cutover.
    ...(typeof stored?.imessageNotify === "boolean"
      ? { imessageNotify: stored.imessageNotify }
      : {}),
    // Onboarding wizard "skip for now" on the message-jace step (three-step
    // rebuild; field name predates the rename — see the schema doc-comment)
    // — preserved across merges so a later config patch (e.g. a label edit)
    // never silently un-skips the workspace's choice. Lives on the telegram
    // row; read by `apps/console/lib/onboarding-data.ts`.
    ...(stored?.channelSkippedAt ? { channelSkippedAt: stored.channelSkippedAt } : {}),
    // Onboarding wizard "skip for now" on the Connect-GitHub / Invite-team
    // steps (three-step rebuild) — both preserved across merges for the same
    // reason as channelSkippedAt above. Live on the github row (see the
    // schema doc-comments on ConnectorConfig for why invite-team piggybacks
    // here too).
    ...(stored?.githubSkippedAt ? { githubSkippedAt: stored.githubSkippedAt } : {}),
    ...(stored?.inviteTeamSkippedAt
      ? { inviteTeamSkippedAt: stored.inviteTeamSkippedAt }
      : {}),
    // Railway evidence connector (Task 7) — preserved across merges so a
    // later config patch (e.g. re-saving the token) never strips the
    // project id, same reasoning as chatId/channelId above.
    ...(stored?.railwayProjectId ? { railwayProjectId: stored.railwayProjectId } : {}),
    // Evidence Providers Wave 2 (Task P0) — the wave's ten non-secret
    // companion fields, preserved across merges for the same reason as
    // railwayProjectId above: a later, unrelated config patch (e.g.
    // re-saving the secret, or a trigger-label edit) must never silently
    // strip a value the workspace already saved.
    ...(stored?.langfuseHost ? { langfuseHost: stored.langfuseHost } : {}),
    ...(stored?.sentryOrg ? { sentryOrg: stored.sentryOrg } : {}),
    ...(stored?.sentryProject ? { sentryProject: stored.sentryProject } : {}),
    ...(stored?.datadogSite ? { datadogSite: stored.datadogSite } : {}),
    ...(stored?.prometheusUrl ? { prometheusUrl: stored.prometheusUrl } : {}),
    ...(stored?.grafanaUrl ? { grafanaUrl: stored.grafanaUrl } : {}),
    ...(stored?.vercelTeamId ? { vercelTeamId: stored.vercelTeamId } : {}),
    ...(stored?.vercelProjectId ? { vercelProjectId: stored.vercelProjectId } : {}),
    ...(stored?.cloudflareZoneId ? { cloudflareZoneId: stored.cloudflareZoneId } : {}),
    ...(stored?.cloudflareAccountId
      ? { cloudflareAccountId: stored.cloudflareAccountId }
      : {}),
  };
}

function toView(row: {
  provider: string;
  enabled: boolean;
  config: Partial<ConnectorConfig> | null;
  secret?: string | null;
  updatedAt: Date | string | null;
}): ConnectorRowView {
  return {
    provider: row.provider as ConnectorProvider,
    enabled: row.enabled,
    config: completeConfig(row.config),
    hasSecret: Boolean(row.secret),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : (row.updatedAt as string | null),
  };
}

/**
 * Read every connector row for a workspace. The daemon and console both consume
 * this — a workspace with no connectors returns `[]`. Ordered by provider for a
 * stable surface.
 */
export async function getConnectors(
  workspaceId: string
): Promise<ConnectorRowView[]> {
  const rows = await db
    .select()
    .from(connectors)
    .where(eq(connectors.workspaceId, workspaceId))
    .orderBy(connectors.provider);
  return rows.map(toView);
}

/** A connected (enabled + has-secret) connector for a provider, across all
 * workspaces. The local-dev Telegram poller enumerates these to know which bots
 * to poll. `config` carries the non-secret companions (chatId); the bot token is
 * read separately via {@link getConnectorSecret}. */
export interface EnabledConnectorRow {
  workspaceId: string;
  config: ConnectorConfig;
}

/**
 * List every ENABLED connector of `provider` that has a stored credential, across
 * all workspaces. SERVER/DAEMON ONLY (it walks workspaces). The Telegram polling
 * driver uses this to find each connected bot to long-poll on a local dev box.
 * Disabled rows and rows with no secret are excluded — there is nothing to poll.
 */
export async function listEnabledConnectors(
  provider: ConnectorProvider
): Promise<EnabledConnectorRow[]> {
  const rows = await db
    .select({
      workspaceId: connectors.workspaceId,
      config: connectors.config,
      secret: connectors.secret,
    })
    .from(connectors)
    .where(and(eq(connectors.provider, provider), eq(connectors.enabled, true)))
    .orderBy(connectors.workspaceId);
  return rows
    .filter((r) => Boolean(r.secret))
    .map((r) => ({
      workspaceId: r.workspaceId,
      config: completeConfig(r.config),
    }));
}

/** Read a single connector row, or null when the workspace hasn't connected it. */
export async function getConnector(
  workspaceId: string,
  provider: ConnectorProvider
): Promise<ConnectorRowView | null> {
  const rows = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.provider, provider)
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? toView(row) : null;
}

/**
 * Upsert a connector row. On first connect this CREATES the row enabled with
 * sane defaults (self-configuring the heartbeat for it); subsequent calls patch
 * only the provided fields. `config` is merged key-by-key over what is stored so
 * a partial config update (e.g. only the label) keeps the other keys.
 *
 * Callers should pass an update already run through {@link validateConnectorUpdate}.
 */
export async function upsertConnector(
  workspaceId: string,
  provider: ConnectorProvider,
  update: ConnectorUpdate = {}
): Promise<ConnectorRowView> {
  const now = new Date();

  // Read the existing row so we can merge config keys (drizzle's jsonb set
  // replaces the whole value; we want a per-key merge to preserve repos/label).
  const existing = await getConnector(workspaceId, provider);
  const mergedConfig: ConnectorConfig = {
    ...completeConfig(existing?.config),
    ...(update.config ?? {}),
  };
  const enabled = update.enabled ?? existing?.enabled ?? true;

  await db
    .insert(connectors)
    .values({
      workspaceId,
      provider,
      enabled,
      config: mergedConfig,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [connectors.workspaceId, connectors.provider],
      set: { enabled, config: mergedConfig, updatedAt: now },
    });

  return {
    provider,
    enabled,
    config: mergedConfig,
    hasSecret: existing?.hasSecret ?? false,
    updatedAt: now.toISOString(),
  };
}

/**
 * Store (or clear, with `null`) a connector's write-only credential and upsert
 * its row. Connecting a credential-based connector self-configures it ON; clearing
 * the secret disables the row. The secret is NEVER read back to the client — only
 * the daemon reads it via {@link getConnectorSecret}. `chatId` is the optional
 * non-secret companion the telegram gateway needs (the bot's target chat).
 */
export async function setConnectorSecret(
  workspaceId: string,
  provider: ConnectorProvider,
  secret: string | null,
  opts: { chatId?: string | null; webhookSecret?: string | null } = {}
): Promise<ConnectorRowView> {
  const now = new Date();
  const existing = await getConnector(workspaceId, provider);
  const connecting = secret !== null && secret.length > 0;

  // Merge chatId into config when provided; clearing the secret also clears it.
  const mergedConfig: ConnectorConfig = {
    ...completeConfig(existing?.config),
  };
  if (opts.chatId !== undefined) {
    if (opts.chatId) mergedConfig.chatId = opts.chatId;
    else delete mergedConfig.chatId;
  }
  // Telegram inbound webhook secret (#889): set when provided, cleared on
  // disconnect (along with the chat id) so a stale secret never lingers.
  if (opts.webhookSecret !== undefined) {
    if (opts.webhookSecret) mergedConfig.webhookSecret = opts.webhookSecret;
    else delete mergedConfig.webhookSecret;
  }
  if (!connecting) {
    delete mergedConfig.chatId;
    delete mergedConfig.webhookSecret;
  }

  // Connecting enables the row; disconnecting disables it.
  const enabled = connecting ? true : false;

  // Encrypt at rest — the plaintext credential never touches the column.
  const storedSecret = connecting ? encryptSecret(secret as string) : null;

  await db
    .insert(connectors)
    .values({
      workspaceId,
      provider,
      enabled,
      secret: storedSecret,
      config: mergedConfig,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [connectors.workspaceId, connectors.provider],
      set: { enabled, secret: storedSecret, config: mergedConfig, updatedAt: now },
    });

  return {
    provider,
    enabled,
    config: mergedConfig,
    hasSecret: connecting,
    updatedAt: now.toISOString(),
  };
}

/**
 * Read a connector's raw stored credential. DAEMON/SERVER ONLY — this returns
 * the secret in full so the runner can call the upstream MCP server or post to a
 * gateway channel. Never expose the result to a browser client. Null when the
 * connector has no stored secret (not connected).
 */
export async function getConnectorSecret(
  workspaceId: string,
  provider: ConnectorProvider
): Promise<string | null> {
  const rows = await db
    .select({ secret: connectors.secret })
    .from(connectors)
    .where(
      and(
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.provider, provider)
      )
    )
    .limit(1);
  const stored = rows[0]?.secret;
  // Decrypt only at the point of use (materializing into code / posting). The
  // ciphertext never leaves this layer.
  return stored ? decryptSecret(stored) : null;
}

// --------------------------------------------------------------------------- //
// OAuth Connect Wave 3, W3-T1 (`.superpowers/sdd/plan-oauth.md`) — server-minted,
// single-use OAuth state for the generic authorize-link/callback routes.
//
// DESIGN CHOICE (disclosed, per the plan's own instruction to inspect
// `mintGithubInstallState`/`consumeGithubInstallState` and either generalize
// or pick a no-migration alternative): those two functions
// (`github-app-token.ts`) are GITHUB-HARDCODED — `githubInstallState` /
// `githubInstallStateExpiresAt` are two dedicated columns on `workspaces`,
// good for exactly ONE in-flight state per WORKSPACE, with no provider
// dimension at all. That does not generalize to "one in-flight state per
// (workspace, provider)" without a schema change, and the plan pins NO
// migration for this task. The chosen alternative: mint into
// `connectors.config` (the plan's own explicitly-offered fallback) — the
// EXISTING per-(workspaceId, provider) jsonb column, keyed by two ephemeral
// fields, `oauthState`/`oauthStateExpiresAt`.
//
// SURGICAL, NEVER `upsertConnector` — both functions write via a raw jsonb
// `||` merge / `-` key-delete (the SAME idiom `queries/investigations.ts`'s
// `claimLessonPromotion`/`unclaimLessonPromotion` already established for
// `investigation_items.data`), never through `upsertConnector`'s
// read-completeConfig-then-replace-the-whole-column path. Two reasons:
//   1. `upsertConnector`/`setConnectorSecret` always rewrite the ENTIRE
//      config column from `completeConfig(existing)` — an unrelated write
//      (e.g. toggling the heartbeat, or connecting a DIFFERENT extra field)
//      racing a pending mint would silently wipe the state, since
//      `completeConfig` only preserves an explicit whitelist of fields.
//   2. The inverse matters more: `oauthState`/`oauthStateExpiresAt` are
//      DELIBERATELY never added to that whitelist, so they can NEVER leak
//      back out through `getConnector`/`getConnectors`/`upsertConnector`'s
//      returned `ConnectorRowView.config` — those routes return the full
//      config object verbatim (e.g. the connectors PUT route's JSON
//      response), and a pending state string has no business reaching a
//      browser response even for the SAME workspace's own admin.
//
// Single-use is enforced the SAME way `consumeGithubInstallState` enforces
// it: one atomic `UPDATE … WHERE <state matches AND unexpired> RETURNING`.
// Two callers racing the same state can never both get a match — Postgres
// serializes the row-level UPDATE, so the first clears the key before the
// second's WHERE can still match it (identical reasoning to
// `claimLessonPromotion`'s own doc-comment on this exact race).
// --------------------------------------------------------------------------- //

const OAUTH_STATE_BYTES = 24;
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * Mint a fresh single-use OAuth state for (workspaceId, provider) and store
 * it (with its 30-minute expiry) into that row's `config`, creating the row
 * first if this is the workspace's first-ever attempt at this provider
 * (`enabled: true`, otherwise-default config — mirrors `upsertConnector`'s
 * own create-on-first-touch default; a real credential is only ever written
 * later, by `setConnectorSecret`, so this alone never flips `hasSecret`).
 * Re-minting while a prior state is still pending simply overwrites it (the
 * prior state stops working) — same one-in-flight-state tradeoff
 * `mintGithubInstallState` already accepts for its own column.
 */
export async function mintConnectorOauthState(
  workspaceId: string,
  provider: ConnectorProvider
): Promise<string> {
  const state = randomBytes(OAUTH_STATE_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const patch = sql`jsonb_build_object('oauthState', ${state}::text, 'oauthStateExpiresAt', ${expiresAt}::text)`;

  await db
    .insert(connectors)
    .values({
      workspaceId,
      provider,
      enabled: true,
      config: { ...CONNECTOR_CONFIG_DEFAULTS, oauthState: state, oauthStateExpiresAt: expiresAt },
    })
    .onConflictDoUpdate({
      target: [connectors.workspaceId, connectors.provider],
      // Surgical merge — touches ONLY these two keys on an existing row's
      // config, never replaces it wholesale. See this section's own
      // doc-comment for why that matters.
      set: { config: sql`${connectors.config} || ${patch}`, updatedAt: new Date() },
    });

  return state;
}

/**
 * Atomically redeem a single-use OAuth state for `provider`, scoped across
 * every workspace (the caller — the callback route — does not yet know
 * which workspace this is; that is exactly what this lookup reveals, never
 * a round-tripped query param — see the plan's "never trust round-tripped
 * workspace ids" pin). Clears BOTH ephemeral keys on match (jsonb `-`
 * key-delete, ONE atomic statement with the match check in the same WHERE)
 * so a replay of the same state — expired or not — can never resolve twice.
 * `null` on no match (unknown / expired / already-consumed state), covering
 * all three identically, same anti-enumeration posture
 * `consumeGithubInstallState` already takes for its own column.
 */
export async function consumeConnectorOauthState(
  provider: ConnectorProvider,
  state: string
): Promise<{ workspaceId: string } | null> {
  const now = new Date().toISOString();
  const [row] = await db
    .update(connectors)
    .set({
      config: sql`${connectors.config} - 'oauthState' - 'oauthStateExpiresAt'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectors.provider, provider),
        sql`(${connectors.config} ->> 'oauthState') = ${state}`,
        sql`(${connectors.config} ->> 'oauthStateExpiresAt') > ${now}`
      )
    )
    .returning({ workspaceId: connectors.workspaceId });
  return row ? { workspaceId: row.workspaceId } : null;
}

/** The MCP providers whose keys are materialized into a run's codebase config. */
const MCP_PROVIDERS = ["linear", "figma", "context7"] as const;

/**
 * Decrypted MCP keys for a workspace's connected MCP connectors, keyed by
 * provider — SERVER ONLY. The runner-claim route hands these to the runner (over
 * the authenticated link) so it can write the agent's MCP config (.mcp.json /
 * .codex/config.toml) into the cloned repo. Only providers with a stored secret
 * appear; the plaintext never reaches a browser client.
 */
export async function getMcpConnectorKeys(
  workspaceId: string
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const provider of MCP_PROVIDERS) {
    const secret = await getConnectorSecret(workspaceId, provider);
    if (secret) out[provider] = secret;
  }
  return out;
}
