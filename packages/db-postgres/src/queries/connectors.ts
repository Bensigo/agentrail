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

    // Sentry OAuth connector (Task W3-T3): the workspace's Sentry
    // installation id, normally written ONLY via postExchange's configPatch
    // (`lib/oauth/sentry.ts`, bypassing this validator entirely — the
    // callback route calls `upsertConnector` directly). Validated here too,
    // same shape as railwayProjectId immediately above, so the field is a
    // fully well-behaved ConnectorConfig member reachable through the
    // generic PATCH path as well (defense in depth / consistency — see the
    // schema doc-comment on ConnectorConfig.sentryInstallationId).
    if (cfg.sentryInstallationId !== undefined) {
      if (typeof cfg.sentryInstallationId !== "string") {
        return { ok: false, error: "sentryInstallationId must be a string" };
      }
      const trimmed = cfg.sentryInstallationId.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "sentryInstallationId must not be empty" };
      }
      if (trimmed.length > 64) {
        return { ok: false, error: "sentryInstallationId must be at most 64 characters" };
      }
      out.sentryInstallationId = trimmed;
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
    // Sentry OAuth connector (Task W3-T3) — preserved across merges for the
    // identical reason as railwayProjectId immediately above: a later,
    // unrelated config patch (re-saving a token-paste secret, a
    // triggerLabel edit, a postExchange configPatch landing on the SAME row
    // from a different concern) must never silently drop the installation
    // id a prior OAuth connect already resolved. NOT ephemeral (see the
    // schema doc-comment) — this preserve-line is the ONLY thing standing
    // between "declared on ConnectorConfig" and "silently stripped on the
    // very next write," exactly the class of bug review IMPORTANT-1 caught
    // for the (deliberately ephemeral) oauthState fields below.
    ...(stored?.sentryInstallationId ? { sentryInstallationId: stored.sentryInstallationId } : {}),
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
    // OAuth Connect Wave 3, W3-T1 fix round (review IMPORTANT-1): the three
    // ephemeral oauth-state fields now survive an UNRELATED config patch
    // (e.g. re-saving triggerLabel, or a teammate's own connect attempt on a
    // DIFFERENT field) the same way railwayProjectId/chatId/etc. do above —
    // an admin who has a Railway consent tab open must not have their
    // pending state silently wiped by an unrelated write landing on the
    // SAME row in the meantime. This is the reverse-direction fix to
    // `mintConnectorOauthState`'s own surgical jsonb patch (which already
    // protects the OTHER direction: an oauth-state mint/consume never
    // clobbers railwayProjectId/etc.). Preserving them here does NOT
    // reintroduce the client-leak this task's original doc-comment warned
    // about: {@link toClientSafeConfig}, applied at every function in this
    // file that returns a `ConnectorRowView` to a caller, strips these
    // three keys again before anything reaches a route response — they
    // survive in STORAGE (this function) but never in the READ MODEL.
    ...(stored?.oauthState ? { oauthState: stored.oauthState } : {}),
    ...(stored?.oauthStateExpiresAt
      ? { oauthStateExpiresAt: stored.oauthStateExpiresAt }
      : {}),
    ...(stored?.oauthUserId ? { oauthUserId: stored.oauthUserId } : {}),
    // OAuth Connect Wave 3, W3-T2 fix round (PKCE upgrade) — preserved
    // across an unrelated write for the exact same reason as
    // oauthState/oauthStateExpiresAt/oauthUserId above; see
    // ConnectorConfig.oauthPkceVerifier's own doc-comment.
    ...(stored?.oauthPkceVerifier ? { oauthPkceVerifier: stored.oauthPkceVerifier } : {}),
  };
}

/**
 * The ephemeral, server-internal-only config keys `completeConfig` now
 * preserves across an unrelated write (review IMPORTANT-1, above) but which
 * must NEVER reach a `ConnectorRowView` a route hands back to a browser —
 * `mintConnectorOauthState`/`consumeConnectorOauthState` are the only
 * legitimate readers/writers of them (via their own targeted jsonb
 * patches, never through this whitelist). Applied at every point in this
 * file that turns a stored config into a `ConnectorRowView`: {@link toView}
 * (backs `getConnector`/`getConnectors`) and the return values of
 * {@link upsertConnector}/{@link setConnectorSecret} (both of which build
 * their OWN merged config for the DB write, independently of `toView`).
 */
const EPHEMERAL_CONFIG_KEYS = [
  "oauthState",
  "oauthStateExpiresAt",
  "oauthUserId",
  // W3-T2 fix round (PKCE upgrade) — same ephemeral, server-internal-only
  // treatment as the three above.
  "oauthPkceVerifier",
] as const;

function toClientSafeConfig(config: ConnectorConfig): ConnectorConfig {
  const safe: ConnectorConfig = { ...config };
  for (const key of EPHEMERAL_CONFIG_KEYS) delete safe[key];
  return safe;
}

/**
 * Internal, NEVER exported: the full row view with `config` normalized via
 * `completeConfig` but NOT stripped of the ephemeral oauth keys. This is
 * the FIX for a bug this fix round's own integration test caught
 * (`oauth-state-consume-race.integration.test.ts`): `upsertConnector`/
 * `setConnectorSecret` need to read the EXISTING row before merging in a
 * caller's partial update, and merging over an ALREADY-STRIPPED config
 * (i.e. one that went through `toClientSafeConfig`) would silently drop a
 * pending `oauthState` on its next unrelated write — exactly the
 * IMPORTANT-1 bug, reintroduced one layer up if these two functions read
 * "existing" through the public, client-safe `getConnector` instead of
 * this raw path. Every EXTERNAL caller still goes through `getConnector`/
 * `getConnectors` (below), which strip via `toClientSafeConfig` before
 * returning — this function is the query layer's own internal detail.
 */
function toRawView(row: {
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

/** Public shape: {@link toRawView} plus the client-safe strip. Backs every
 * EXTERNALLY-visible read (`getConnector`, `getConnectors`). */
function toView(row: Parameters<typeof toRawView>[0]): ConnectorRowView {
  const raw = toRawView(row);
  return { ...raw, config: toClientSafeConfig(raw.config) };
}

/** Internal: read one connector row RAW (ephemeral oauth keys intact, if
 * present) — see {@link toRawView}'s own doc-comment for why this exists
 * as a distinct path from the public {@link getConnector}. Not exported. */
async function getConnectorRaw(
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
  return row ? toRawView(row) : null;
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

/** Read a single connector row, or null when the workspace hasn't connected
 * it. Client-safe (built on {@link getConnectorRaw} + `toClientSafeConfig`
 * — never surfaces the ephemeral oauth keys). */
export async function getConnector(
  workspaceId: string,
  provider: ConnectorProvider
): Promise<ConnectorRowView | null> {
  const raw = await getConnectorRaw(workspaceId, provider);
  return raw ? { ...raw, config: toClientSafeConfig(raw.config) } : null;
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

  // Read the existing row RAW (via getConnectorRaw, NOT the public
  // getConnector) so a pending oauthState is visible to completeConfig's
  // preserve-list below — reading through the client-safe getConnector
  // here would silently re-strip it before completeConfig ever saw it,
  // reintroducing the IMPORTANT-1 clobber bug one layer up (this fix
  // round's own integration test caught exactly this).
  const existing = await getConnectorRaw(workspaceId, provider);
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
    // The DB write above persists the un-stripped `mergedConfig` (so a
    // pending oauthState survives this unrelated write — review
    // IMPORTANT-1); the RETURNED view strips it again so it never reaches
    // whatever route/caller invoked this (e.g. the connectors PUT route's
    // JSON response) — see `toClientSafeConfig`'s own doc-comment.
    config: toClientSafeConfig(mergedConfig),
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
  // Raw read — see upsertConnector's identical comment just above for why
  // this must NOT be the client-safe getConnector.
  const existing = await getConnectorRaw(workspaceId, provider);
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
    // Same split as `upsertConnector` above: the DB write persists the
    // un-stripped `mergedConfig`, the returned view strips the ephemeral
    // oauth keys again.
    config: toClientSafeConfig(mergedConfig),
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
// SURGICAL, NEVER `upsertConnector` for the WRITE side — both functions
// write via a raw jsonb `||` merge / `-` key-delete (the SAME idiom
// `queries/investigations.ts`'s `claimLessonPromotion`/
// `unclaimLessonPromotion` already established for `investigation_items.data`),
// never through `upsertConnector`'s read-completeConfig-then-replace-the-
// whole-column path — an unrelated write (toggling the heartbeat, connecting
// a different extra field) racing a pending mint must never wipe it. As of
// the W3-T1 fix round (review IMPORTANT-1), the REVERSE is also now true:
// `completeConfig` (used by `upsertConnector`/`setConnectorSecret`)
// preserves these ephemeral keys across ITS OWN unrelated writes, so the
// protection is bidirectional. They still never leak to a browser —
// `toClientSafeConfig` (this file, above) strips them from every returned
// `ConnectorRowView` regardless of which function produced it.
//
// Single-use is enforced the SAME way `consumeGithubInstallState` enforces
// it: one atomic `UPDATE … WHERE <state matches AND unexpired> RETURNING`.
// Two callers racing the same state can never both get a match — Postgres
// serializes the row-level UPDATE, so the first clears the key before the
// second's WHERE can still match it (identical reasoning to
// `claimLessonPromotion`'s own doc-comment on this exact race; proven
// against a REAL Postgres race, not just this claim, by
// `src/__tests__/oauth-state-consume-race.integration.test.ts`).
//
// TENANT-BINDING FIX (review CRITICAL-1, W3-T1 fix round): the ORIGINAL
// shape bound state to (workspaceId, provider) alone. That is enough to
// defeat FORGERY (state can't be guessed/replayed) but nothing about
// MISDIRECTION — the person who *mints* a state and the person who
// *redeems* it were never required to be the same person, so an attacker
// who is legitimately owner/admin of their OWN workspace could mint a
// state, send the real vendor authorize URL to an unrelated victim as a
// phishing pretext, and have the victim's own OAuth grant land in the
// attacker's workspace when the victim (who need not even have an
// AgentRail account) completes the vendor's consent screen. A THIRD
// ephemeral field, `oauthUserId`, now binds the MINTING user's id
// alongside workspaceId/provider; the callback route (the actual
// enforcement point — see its own doc-comment) requires the redeeming
// session's user to equal this bound id AND still hold owner/admin
// membership on the bound workspace before it will exchange the code,
// mirroring `connectors/github/install-callback/route.ts`'s own
// session+membership gate for the same class of public, tenant-writing
// OAuth-style callback.
// --------------------------------------------------------------------------- //

const OAUTH_STATE_BYTES = 24;
/** Default TTL — param-transport (Railway): state round-trips through the
 * vendor, is minter-bound, and single-use, so a long-lived pending window
 * is low-risk (an unrelated party can't do anything with a leaked
 * `state`+`code` pair without ALSO controlling the minting user's own
 * session). See {@link SESSION_TRANSPORT_OAUTH_STATE_TTL_MS} for why
 * session-transport does NOT get this same 30-minute default. */
export const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;
/**
 * W3-T3 second fix round (independent review Finding 1, `.superpowers/sdd/
 * review-W3T3.md`) — a DELIBERATELY SHORTER TTL for session-transport
 * providers (Sentry). Session-transport tenant binding does not (and
 * structurally cannot, given the vendor round-trips nothing) verify that
 * the `code`/`installationId` presented at the callback actually
 * originated from THIS pending record — it only verifies "the redeeming
 * session has exactly one pending mint of its own." A leaked
 * `code`+`installationId` (browser history, an access log, a pasted URL)
 * can therefore be redeemed by ANY unrelated user who starts their own
 * ordinary connect attempt and presents the leaked artifact instead of
 * their own — the pending record's own TTL is the ONLY thing bounding how
 * long that unrelated user's own "catch" window stays open (see
 * `connectors/oauth/callback/[provider]/route.ts`'s own doc-comment,
 * "SESSION-TRANSPORT CSRF ANALYSIS", for the full honest scoping of this
 * residual risk — param-transport has no equivalent gap, hence no
 * equivalent need to shrink its own window). 10 minutes (a third of
 * param-transport's 30) meaningfully narrows the practical exploit window
 * without being so short it routinely expires on a legitimate user who
 * pauses mid-flow (e.g. picking an org on Sentry's own consent screen).
 */
export const SESSION_TRANSPORT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Mint a fresh single-use OAuth state for (workspaceId, provider), bound to
 * the MINTING user's id (review CRITICAL-1 — see this section's own
 * doc-comment, "TENANT-BINDING FIX"), and store it (with its expiry —
 * {@link OAUTH_STATE_TTL_MS} by default, {@link ttlMs} overrides it) into
 * that row's `config`, creating the row first if this is the workspace's
 * first-ever attempt at this provider (`enabled: true`, otherwise-default
 * config — mirrors `upsertConnector`'s own create-on-first-touch default; a
 * real credential is only ever written later, by `setConnectorSecret`, so
 * this alone never flips `hasSecret`). Re-minting while a prior state is
 * still pending simply overwrites it (the prior state stops working) — same
 * one-in-flight-state tradeoff `mintGithubInstallState` already accepts for
 * its own column.
 *
 * `codeVerifier` (W3-T2 fix round, PKCE upgrade — optional, 4th arg):
 * when the link route mints a PKCE `code_verifier`
 * (`apps/console/lib/oauth/pkce.ts`), it rides in the SAME surgical jsonb
 * patch as `state`/`expiresAt`/`userId` — one ephemeral per-attempt bag,
 * not a second storage mechanism. Omitted (undefined) for a provider whose
 * adapter doesn't use PKCE — the stored config simply carries no
 * `oauthPkceVerifier` key in that case, exactly like today.
 *
 * `ttlMs` (W3-T3 second fix round, optional 5th arg — additive, defaults to
 * {@link OAUTH_STATE_TTL_MS} so every EXISTING call site, and every
 * param-transport provider, is byte-unchanged): the link route passes
 * {@link SESSION_TRANSPORT_OAUTH_STATE_TTL_MS} for a `stateTransport:
 * "session"` provider — see that constant's own doc-comment for why. The
 * shorter window is enforced ENTIRELY here, at mint time, by storing an
 * earlier absolute `oauthStateExpiresAt` — neither
 * `consumeConnectorOauthState` nor `consumeConnectorOauthStateBySessionUser`
 * needs (or has) any transport-conditional logic of their own: both simply
 * compare the STORED timestamp against `now`, generically, exactly as
 * before this fix round. The asymmetry lives in ONE place (this function's
 * own default), not duplicated at every read site.
 */
export async function mintConnectorOauthState(
  workspaceId: string,
  provider: ConnectorProvider,
  userId: string,
  codeVerifier?: string,
  ttlMs: number = OAUTH_STATE_TTL_MS
): Promise<string> {
  const state = randomBytes(OAUTH_STATE_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const patch = sql`jsonb_build_object(
    'oauthState', ${state}::text,
    'oauthStateExpiresAt', ${expiresAt}::text,
    'oauthUserId', ${userId}::text,
    'oauthPkceVerifier', ${codeVerifier ?? null}::text
  )`;

  await db
    .insert(connectors)
    .values({
      workspaceId,
      provider,
      enabled: true,
      config: {
        ...CONNECTOR_CONFIG_DEFAULTS,
        oauthState: state,
        oauthStateExpiresAt: expiresAt,
        oauthUserId: userId,
        ...(codeVerifier ? { oauthPkceVerifier: codeVerifier } : {}),
      },
    })
    .onConflictDoUpdate({
      target: [connectors.workspaceId, connectors.provider],
      // Surgical merge — touches ONLY these four keys on an existing row's
      // config, never replaces it wholesale. See this section's own
      // doc-comment for why that matters. `jsonb_build_object` always
      // includes all four keys (a `null` `oauthPkceVerifier` when
      // `codeVerifier` is omitted) so the `||` merge deterministically
      // overwrites any STALE verifier from a prior mint attempt too — never
      // leaves an old one behind for a provider that used to send one and
      // no longer does.
      set: { config: sql`${connectors.config} || ${patch}`, updatedAt: new Date() },
    });

  return state;
}

/**
 * Atomically redeem a single-use OAuth state for `provider`, scoped across
 * every workspace (the caller — the callback route — does not yet know
 * which workspace this is; that is exactly what this lookup reveals, never
 * a round-tripped query param — see the plan's "never trust round-tripped
 * workspace ids" pin). Clears the two expiry/single-use keys on match (jsonb
 * `-` key-delete, ONE atomic statement with the match check in the SAME
 * WHERE, unchanged by this fix round) so a replay of the same state —
 * expired or not — can never resolve twice; proven against a real Postgres
 * concurrent race by `oauth-state-consume-race.integration.test.ts`. `null`
 * on no match (unknown / expired / already-consumed state), covering all
 * three identically, same anti-enumeration posture `consumeGithubInstallState`
 * already takes for its own column.
 *
 * Returns the bound `userId` ALONGSIDE `workspaceId` (review CRITICAL-1) —
 * the callback route's real enforcement point compares it against the
 * redeeming session. `oauthUserId` is deliberately NOT cleared by this
 * statement's own `SET` (only `oauthState`/`oauthStateExpiresAt` are): a
 * jsonb column's `RETURNING` reflects the POST-update value, so reading a
 * key requires leaving it untouched by the SAME statement's `SET` — see the
 * `- 'oauthState' - 'oauthStateExpiresAt'` expression below, which
 * deliberately does not include `- 'oauthUserId'`. The value has no further
 * use once read here and is superseded by the next mint's own patch
 * regardless, so leaving it in place after consumption is a harmless,
 * disclosed simplification (it is not part of the client-facing read
 * model either way — {@link toClientSafeConfig} strips it from every
 * `ConnectorRowView`). A row whose `oauthUserId` is somehow absent (should
 * never happen post-fix; defensive only) fails CLOSED — `null`, never a
 * partial/unbound result the callback route might mistakenly trust.
 *
 * Also returns `codeVerifier` (W3-T2 fix round, PKCE upgrade) — the SAME
 * disclosed simplification as `oauthUserId` applies: not cleared by this
 * statement's own `SET` either (no further use once read, superseded by
 * the next mint's patch regardless), never part of the client-facing read
 * model. `null` when the mint never carried one (a provider whose adapter
 * doesn't use PKCE) — never a hard failure the way a missing `oauthUserId`
 * is, since PKCE is optional per provider.
 */
export async function consumeConnectorOauthState(
  provider: ConnectorProvider,
  state: string
): Promise<{ workspaceId: string; userId: string; codeVerifier: string | null } | null> {
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
    .returning();
  if (!row) return null;
  const cfg = row.config as ConnectorConfig | null;
  const userId = cfg?.oauthUserId;
  if (!userId) return null;
  const codeVerifier = typeof cfg?.oauthPkceVerifier === "string" ? cfg.oauthPkceVerifier : null;
  return { workspaceId: row.workspaceId, userId, codeVerifier };
}

// --------------------------------------------------------------------------- //
// OAuth Connect Wave 3, W3-T3 fix round (coordinator ruling on the
// state-round-trip finding — `.superpowers/sdd/task-W3T3-report.md`,
// `apps/console/lib/oauth/types.ts`'s `stateTransport` doc-comment) —
// SESSION-TRANSPORT tenant binding, for a provider (so far only Sentry)
// whose vendor redirect cannot carry a `state` token at all. Two functions,
// used together by the link/callback routes INSTEAD OF
// mintConnectorOauthState's plain call / consumeConnectorOauthState — the
// underlying STORAGE mechanism (the same four ephemeral connectors.config
// jsonb keys, the same mintConnectorOauthState mint) is unchanged; only how
// the pending record is FOUND at redemption time differs, because there is
// no vendor-echoed token to look it up by.
// --------------------------------------------------------------------------- //

/**
 * Session-transport providers only, called by the link route BEFORE
 * `mintConnectorOauthState` — clears every OTHER pending oauth state this
 * user has minted for `provider`, across every workspace. Last-mint-wins
 * per (user, provider): without this, a user who opens the connect flow
 * twice (two tabs, a retry after backing out of the vendor's consent
 * screen) leaves an earlier, still-pending record around, which would
 * manufacture false ambiguity for {@link consumeConnectorOauthStateBySessionUser}'s
 * own "exactly one match" requirement — turning an ordinary retry into a
 * rejected connect. Same "clear only the ephemeral state keys, leave
 * `oauthUserId`/`oauthPkceVerifier` as a harmless disclosed leftover" shape
 * as `consumeConnectorOauthState`'s own clear — the discriminating field
 * for "is this row pending" is `oauthState IS NOT NULL`; nothing else ever
 * reads the stale leftovers without it.
 *
 * BOUNDED QUERY (disclosed): a single UPDATE filtered on `provider` (a
 * plain text column) AND a jsonb `oauthUserId` match — no dedicated index
 * on either jsonb key. Acceptable because pending records are RARE (one
 * per in-flight connect attempt) and TTL'd (30 minutes,
 * `OAUTH_STATE_TTL_MS` above) — the realistic matching-row count for any
 * one user is 0 or 1 in the overwhelming common case, and the total
 * `connectors` row count for one provider is bounded by this deployment's
 * total workspace count, not global scale. No transaction needed: this is
 * a single statement, and Postgres's own row-level locking already makes
 * it atomic with respect to itself; the caller's SUBSEQUENT
 * `mintConnectorOauthState` call is a separate statement (a benign gap if
 * a request dies in between — the target workspace simply has no pending
 * state yet, the same as before either call ran).
 */
export async function clearPendingConnectorOauthStatesForUser(
  provider: ConnectorProvider,
  userId: string
): Promise<void> {
  await db.execute(sql`
    UPDATE connectors
    SET config = config - 'oauthState' - 'oauthStateExpiresAt', updated_at = now()
    WHERE provider = ${provider}
      AND (config ->> 'oauthUserId') = ${userId}
      AND (config ->> 'oauthState') IS NOT NULL
  `);
}

/**
 * Session-transport providers only — the callback route's replacement for
 * `consumeConnectorOauthState` when the vendor's redirect carries no
 * `state` token to look a pending record up by. Resolves the pending
 * record by the REDEEMING SESSION's own `userId` instead: finds every
 * unexpired row across EVERY workspace where `provider` matches and
 * `config.oauthUserId = userId` and a state is still pending, and requires
 * EXACTLY ONE such row — zero or multiple is ambiguous and returns `null`
 * WITHOUT consuming anything (see this function's own "AMBIGUITY MUST NOT
 * CONSUME" note below). `mintedByUserId` in the result always equals the
 * `userId` argument by construction (the lookup was keyed by it) — callers
 * do not need a separate equality check the way `consumeConnectorOauthState`'s
 * callers do.
 *
 * ATOMICITY UNDER CONCURRENCY (proven against a REAL Postgres race, not
 * just this reasoning — see this package's
 * `oauth-state-consume-race.integration.test.ts`): `SELECT ... FOR UPDATE`
 * locks every candidate row up front. Two callers racing the SAME single
 * pending record: the first to acquire the lock proceeds; the second's
 * `SELECT ... FOR UPDATE` BLOCKS on that lock, and — this is the important
 * part, and NOT the same shape as this package's own documented
 * EvalPlanQual CTE-guard gotcha (`investigations.ts`/`github_intake.ts`'s
 * own doc-comments: a CTE's WHERE clause is evaluated ONCE at snapshot
 * time and never re-checked when an OUTER statement's write finally
 * acquires the lock) — once unblocked, Postgres RE-EVALUATES a blocked
 * `SELECT ... FOR UPDATE`'s own WHERE clause against the freshly-committed
 * row version (documented READ COMMITTED locking-read semantics, distinct
 * from the CTE gotcha: there is no separate outer reference going stale
 * here, because the qualifying SELECT itself IS the locking read). Since
 * the first caller already cleared that row's `oauthState`, the second
 * caller's candidate list correctly drops to zero — no double-consume, no
 * stale re-read. The second (UPDATE-by-id) statement, run in the SAME
 * transaction while STILL HOLDING the lock from the first, additionally
 * repeats the `oauthState IS NOT NULL` guard on its OWN WHERE (belt-and-
 * braces, matching this package's own "guard the write's own WHERE, not
 * just an earlier read" doctrine) even though nothing else could have
 * touched the row in between (the lock never released).
 *
 * AMBIGUITY MUST NOT CONSUME: when candidates.length !== 1 (the user has
 * zero pending records for this provider, or — same-user, two-workspace
 * ambiguity — more than one open at once), this function returns `null`
 * and performs NO write at all. Consuming (or worse, picking) one of
 * several ambiguous candidates would silently connect the WRONG
 * workspace's pending attempt to whichever code/installationId this
 * request happens to carry — there is no vendor-echoed token here to
 * disambiguate which pending attempt this specific redirect belongs to,
 * so the only safe answer under ambiguity is to leave every candidate
 * exactly as it was and let the admin complete one connect attempt at a
 * time (see the callback route's own "SESSION-TRANSPORT CSRF ANALYSIS"
 * for why this is a disclosed UX tradeoff, not a security hole).
 */
export async function consumeConnectorOauthStateBySessionUser(
  provider: ConnectorProvider,
  userId: string
): Promise<{ workspaceId: string; userId: string; codeVerifier: string | null } | null> {
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const candidates = Array.from(
      (await tx.execute(sql`
        SELECT id, workspace_id, config
        FROM connectors
        WHERE provider = ${provider}
          AND (config ->> 'oauthUserId') = ${userId}
          AND (config ->> 'oauthState') IS NOT NULL
          AND (config ->> 'oauthStateExpiresAt') > ${now}
        FOR UPDATE
      `)) as unknown as Array<{ id: string; workspace_id: string; config: ConnectorConfig | null }>
    );

    if (candidates.length !== 1) {
      return null;
    }

    const row = candidates[0]!;
    const codeVerifier = typeof row.config?.oauthPkceVerifier === "string" ? row.config.oauthPkceVerifier : null;

    const updated = Array.from(
      (await tx.execute(sql`
        UPDATE connectors
        SET config = config - 'oauthState' - 'oauthStateExpiresAt', updated_at = now()
        WHERE id = ${row.id} AND (config ->> 'oauthState') IS NOT NULL
        RETURNING id
      `)) as unknown as Array<{ id: string }>
    );
    // Defensive only — should be unreachable given the lock acquired by the
    // SELECT above is held continuously across both statements in this
    // transaction, so nothing else could have cleared it in between.
    if (updated.length === 0) return null;

    return { workspaceId: row.workspace_id, userId, codeVerifier };
  });
}

// --------------------------------------------------------------------------- //
// W3-T5 (unplanned fast-follow, `.superpowers/sdd/task-W3T5-report.md`) — the
// Sentry integration webhook receiver's own connector lookup/teardown.
// Sentry POSTs installation lifecycle events (installation.created/.deleted)
// to a single, provider-scoped-but-not-workspace-scoped URL
// (`apps/console/app/api/v1/connectors/webhooks/sentry/route.ts`) that knows
// only the vendor's installation uuid from the payload — NOT which
// workspace it belongs to, unlike every OTHER function in this file, which
// always receives a `workspaceId` argument from an already-authenticated
// caller. These two functions are the cross-workspace resolution + guarded
// teardown that route needs: `findConnectorsBySentryInstallationId` is the
// READ half (an installationId resolves to AT MOST ONE workspace in the
// ordinary case — minted once, by `postExchange`'s own configPatch in
// `lib/oauth/sentry.ts` — but nothing in this schema enforces that as a
// hard invariant, so this returns every match rather than assuming
// exactly one); `clearSentryConnectorForInstallation` is the WRITE half,
// called ONCE PER MATCH by the route.
// --------------------------------------------------------------------------- //

/** One workspace whose `sentry` connector's stored `config.sentryInstallationId`
 * matches a given Sentry installation uuid. */
export interface SentryInstallationConnectorMatch {
  workspaceId: string;
}

/**
 * Cross-workspace lookup: every `sentry` connector row whose
 * `config.sentryInstallationId` equals `installationId` exactly (a Sentry
 * installation uuid — `payload.installation.uuid` on the webhook's own
 * verified body, doc-confirmed present on every resource type). SERVER
 * ONLY — the webhook route is the sole caller; there is no browser-facing
 * use for "which workspace owns this vendor id" (unlike every other read
 * in this file, this one is NOT scoped by an already-known workspaceId).
 * Returns `[]` for an unknown or already-disconnected installation — a
 * benign no-op the caller treats as "nothing to clear", never an error.
 */
export async function findConnectorsBySentryInstallationId(
  installationId: string
): Promise<SentryInstallationConnectorMatch[]> {
  const rows = await db
    .select({ workspaceId: connectors.workspaceId })
    .from(connectors)
    .where(
      and(
        eq(connectors.provider, "sentry"),
        sql`(${connectors.config} ->> 'sentryInstallationId') = ${installationId}`
      )
    );
  return rows;
}

/**
 * Clears a `sentry` connector's stored secret and removes its
 * `sentryInstallationId` from config — called once per workspace
 * {@link findConnectorsBySentryInstallationId} resolved, when Sentry's
 * `installation.deleted` webhook reports the Public Integration was
 * uninstalled from Sentry's own side. Mirrors `setConnectorSecret`'s own
 * "no secret -> disabled" convention (`enabled: false`) so `hasSecret` /
 * the connectors sheet honestly show "not connected" — and ADDITIONALLY
 * strips `sentryInstallationId`, which `setConnectorSecret` alone does NOT
 * do (that function only ever touches `chatId`/`webhookSecret` on clear —
 * see its own doc-comment; `sentryInstallationId` is declared NOT
 * ephemeral on `ConnectorConfig` specifically so `completeConfig` always
 * PRESERVES it across every other write, which makes a raw jsonb `-`
 * key-delete the ONLY way to ever remove it). Without this, a stale
 * `sentryInstallationId` would keep pointing at a dead installation:
 * harmless to `resolveProviderAuth` (its cheap `!secret` gate alone already
 * makes this connector read as disconnected the instant `secret` is NULL),
 * but dishonest to anything that reads config directly.
 *
 * GUARDED ON THIS UPDATE'S OWN WHERE (house doctrine — mirrors
 * {@link consumeConnectorOauthStateBySessionUser}'s own doc-comment on
 * "guard the write, not just an earlier read"): the WHERE re-checks
 * `installationId` directly, rather than trusting
 * `findConnectorsBySentryInstallationId`'s earlier snapshot — a benign race
 * (the workspace reconnected with a FRESH installationId between the
 * route's lookup and this write) makes the WHERE match nothing, so this
 * safely no-ops instead of clobbering a live connection that no longer has
 * anything to do with the uninstalled one. No transaction/locking needed
 * beyond that: this is a single guarded statement, and Postgres's own
 * row-level write already serializes it against any concurrent writer, the
 * same way every other single-UPDATE function in this file already relies
 * on.
 *
 * Returns whether a row actually matched and was cleared — `false` is not
 * an error (already cleared by a prior delivery, or superseded by a fresh
 * reconnect racing this one); the route logs accordingly either way.
 */
export async function clearSentryConnectorForInstallation(
  workspaceId: string,
  installationId: string
): Promise<boolean> {
  const [row] = await db
    .update(connectors)
    .set({
      secret: null,
      enabled: false,
      config: sql`${connectors.config} - 'sentryInstallationId'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectors.workspaceId, workspaceId),
        eq(connectors.provider, "sentry"),
        sql`(${connectors.config} ->> 'sentryInstallationId') = ${installationId}`
      )
    )
    .returning();
  return Boolean(row);
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
