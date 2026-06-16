import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Heartbeat trigger configuration (MVP, #4) — one row per workspace.
 *
 * The **Heartbeat** is the autonomous loop that polls GitHub for issues labeled
 * `trigger_label` every `poll_interval_seconds` and admits them into the Issue
 * Queue. This table is the *control surface* for it: the console writes it
 * (enable/disable, edit interval+label) and the live daemon READS it to decide
 * whether to run and how often.
 *
 * Note the prerequisite gate is NOT stored here. Whether the heartbeat may run
 * is governed by `agentrail/heartbeat/gate.py` (all three capstone capabilities
 * present); `enabled` here is the operator's intent, gated by that capability
 * check at the daemon. Absence of a row means defaults (disabled).
 */
export const heartbeatConfig = pgTable("heartbeat_config", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  // Operator intent. Defaults OFF — the heartbeat never auto-enables itself.
  enabled: boolean("enabled").notNull().default(false),
  // How often the daemon polls GitHub for labeled issues.
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(60),
  // The GitHub label the daemon polls for (mirrors the connector ingest label).
  triggerLabel: text("trigger_label").notNull().default("ready-for-agent"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type HeartbeatConfig = typeof heartbeatConfig.$inferSelect;
export type NewHeartbeatConfig = typeof heartbeatConfig.$inferInsert;

/** The read model the console surface and daemon both consume. */
export interface HeartbeatConfigView {
  enabled: boolean;
  pollIntervalSeconds: number;
  triggerLabel: string;
  updatedAt: string | null;
}

/** Defaults applied when a workspace has no `heartbeat_config` row yet. */
export const HEARTBEAT_CONFIG_DEFAULTS: Omit<HeartbeatConfigView, "updatedAt"> =
  {
    enabled: false,
    pollIntervalSeconds: 60,
    triggerLabel: "ready-for-agent",
  };
