import { eq, and } from "drizzle-orm";
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

    if (cfg.telegramOffset !== undefined) {
      const n = cfg.telegramOffset;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          error: "telegramOffset must be a non-negative integer",
        };
      }
      out.telegramOffset = n;
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
    // Optional telegram inbound webhook secret (#889) — preserved across merges
    // so a later config patch (e.g. label edit) never strips the inbound auth.
    ...(stored?.webhookSecret ? { webhookSecret: stored.webhookSecret } : {}),
    // Optional telegram polling offset (local-dev getUpdates cursor) — preserved
    // across merges so a later config patch never resets the poller's resume point.
    ...(typeof stored?.telegramOffset === "number"
      ? { telegramOffset: stored.telegramOffset }
      : {}),
    // Jace channel-migration opt-in (#1047) — preserved across merges so a later
    // config patch (e.g. label edit on the jace row) never silently reverts the
    // Telegram-notify cutover for the workspace.
    ...(typeof stored?.telegramNotify === "boolean"
      ? { telegramNotify: stored.telegramNotify }
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
 * to poll. `config` carries the non-secret companions (chatId, telegramOffset);
 * the bot token is read separately via {@link getConnectorSecret}. */
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
    // Disconnect clears the poller's resume cursor too, so a future reconnect
    // (new bot/chat) starts clean rather than resuming a stale offset.
    delete mergedConfig.telegramOffset;
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
