import { eq, and } from "drizzle-orm";
import { db } from "../db.js";
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
  };
}

function toView(row: {
  provider: string;
  enabled: boolean;
  config: Partial<ConnectorConfig> | null;
  updatedAt: Date | string | null;
}): ConnectorRowView {
  return {
    provider: row.provider as ConnectorProvider,
    enabled: row.enabled,
    config: completeConfig(row.config),
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
    updatedAt: now.toISOString(),
  };
}
