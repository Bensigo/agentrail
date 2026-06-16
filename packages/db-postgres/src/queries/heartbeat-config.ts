import { eq } from "drizzle-orm";
import { db } from "../db.js";
import {
  heartbeatConfig,
  HEARTBEAT_CONFIG_DEFAULTS,
  type HeartbeatConfigView,
} from "../schema/heartbeat_config.js";

/** Poll-interval bounds (seconds). Below 10s hammers the GitHub API; a day is
 * the sane upper bound for a "heartbeat". */
export const MIN_POLL_INTERVAL_SECONDS = 10;
export const MAX_POLL_INTERVAL_SECONDS = 86_400;

/** A partial update to a workspace's heartbeat config. */
export interface HeartbeatConfigUpdate {
  enabled?: boolean;
  pollIntervalSeconds?: number;
  triggerLabel?: string;
}

/**
 * Validate a heartbeat-config update. Pure — no I/O. Returns the normalized
 * fields to persist, or an error message. The route and the read model both
 * rely on this being the single source of truth for what is a legal config.
 */
export function validateHeartbeatConfigUpdate(
  update: HeartbeatConfigUpdate
):
  | { ok: true; value: HeartbeatConfigUpdate }
  | { ok: false; error: string } {
  const value: HeartbeatConfigUpdate = {};

  if (update.enabled !== undefined) {
    if (typeof update.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    value.enabled = update.enabled;
  }

  if (update.pollIntervalSeconds !== undefined) {
    const n = update.pollIntervalSeconds;
    if (typeof n !== "number" || !Number.isInteger(n)) {
      return { ok: false, error: "pollIntervalSeconds must be an integer" };
    }
    if (n < MIN_POLL_INTERVAL_SECONDS || n > MAX_POLL_INTERVAL_SECONDS) {
      return {
        ok: false,
        error: `pollIntervalSeconds must be between ${MIN_POLL_INTERVAL_SECONDS} and ${MAX_POLL_INTERVAL_SECONDS}`,
      };
    }
    value.pollIntervalSeconds = n;
  }

  if (update.triggerLabel !== undefined) {
    if (typeof update.triggerLabel !== "string") {
      return { ok: false, error: "triggerLabel must be a string" };
    }
    const trimmed = update.triggerLabel.trim();
    // GitHub labels: non-empty, max 50 chars (GitHub's own limit).
    if (trimmed.length === 0) {
      return { ok: false, error: "triggerLabel must not be empty" };
    }
    if (trimmed.length > 50) {
      return { ok: false, error: "triggerLabel must be at most 50 characters" };
    }
    value.triggerLabel = trimmed;
  }

  return { ok: true, value };
}

/**
 * Read a workspace's heartbeat config (MVP, #4). Returns defaults (disabled,
 * 60s, 'ready-for-agent') when no row exists yet — the daemon and console can
 * always rely on a complete view. This is the read model the live daemon polls.
 */
export async function getHeartbeatConfig(
  workspaceId: string
): Promise<HeartbeatConfigView> {
  const rows = await db
    .select()
    .from(heartbeatConfig)
    .where(eq(heartbeatConfig.workspaceId, workspaceId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { ...HEARTBEAT_CONFIG_DEFAULTS, updatedAt: null };
  }
  return {
    enabled: row.enabled,
    pollIntervalSeconds: row.pollIntervalSeconds,
    triggerLabel: row.triggerLabel,
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : (row.updatedAt as string | null),
  };
}

/**
 * Upsert a workspace's heartbeat config (MVP, #4). Only the provided fields are
 * changed; absent fields keep their stored (or default) value. Returns the new
 * full view. Callers should pass an update already run through
 * {@link validateHeartbeatConfigUpdate}.
 */
export async function setHeartbeatConfig(
  workspaceId: string,
  update: HeartbeatConfigUpdate
): Promise<HeartbeatConfigView> {
  const now = new Date();
  // Insert seeds defaults for any field the caller didn't provide; the
  // onConflict update touches only the provided fields + updated_at.
  const set: Record<string, unknown> = { updatedAt: now };
  if (update.enabled !== undefined) set.enabled = update.enabled;
  if (update.pollIntervalSeconds !== undefined)
    set.pollIntervalSeconds = update.pollIntervalSeconds;
  if (update.triggerLabel !== undefined) set.triggerLabel = update.triggerLabel;

  await db
    .insert(heartbeatConfig)
    .values({
      workspaceId,
      enabled: update.enabled ?? HEARTBEAT_CONFIG_DEFAULTS.enabled,
      pollIntervalSeconds:
        update.pollIntervalSeconds ??
        HEARTBEAT_CONFIG_DEFAULTS.pollIntervalSeconds,
      triggerLabel:
        update.triggerLabel ?? HEARTBEAT_CONFIG_DEFAULTS.triggerLabel,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: heartbeatConfig.workspaceId,
      set,
    });

  return getHeartbeatConfig(workspaceId);
}
