import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

/**
 * Connectors — the per-workspace, per-provider control surface that ALSO
 * configures the Heartbeat.
 *
 * A **Connector** (CONTEXT.md, ADR 0010) is the two-way seam between an external
 * tool and the Issue Queue: it ingests human-created issues into the queue and
 * posts run results back. Adding a connector now self-configures the autonomous
 * loop: the row carries the trigger config the live daemon reads (which label
 * admits work, how often to poll, which repos to watch). This FOLDS IN the
 * former standalone `heartbeat_config` table (#816) — there is no separate
 * heartbeat config any more; the daemon reads connectors.
 *
 * One row per (workspace, provider). The console writes it (enable/disable,
 * edit label + interval); the live daemon (`agentrail/cli/commands/heartbeat.py`
 * via `list_active_connectors`) READS it. Whether the daemon may actually run is
 * still governed by the prerequisite capability gate
 * (`agentrail/heartbeat/gate.py`); `enabled` here is operator intent.
 */
export const connectorProviderEnum = [
  // https — connected at login (GitHub OAuth), no stored secret here.
  "github",
  // mcp — Model-Context-Protocol tool servers the agent can call. Each stores
  // a per-workspace API key/token in the connector's write-only `secret`.
  "linear",
  "figma",
  "context7",
  // gateway — outbound communication channels (notify). Discord keeps its
  // legacy webhook on the workspaces row; slack/telegram store their credential
  // in `secret` (telegram also needs `chatId`, kept in `config`).
  "discord",
  "slack",
  "telegram",
] as const;
export type ConnectorProvider = (typeof connectorProviderEnum)[number];

/** Trigger configuration stored on a connector row (jsonb `config`). */
export interface ConnectorConfig {
  /** GitHub repos (owner/name) the daemon polls. Other providers: empty. */
  repos: string[];
  /** The label that admits an issue into the Issue Queue. */
  triggerLabel: string;
  /** How often the daemon polls for labeled issues. */
  pollIntervalSeconds: number;
  /**
   * Telegram gateway: the chat id the bot posts to (a numeric id or `@channel`).
   * Non-secret display field (the bot token is the secret). Absent for other
   * providers.
   */
  chatId?: string;
}

/** Defaults applied when a connector is first created / for absent config keys. */
export const CONNECTOR_CONFIG_DEFAULTS: ConnectorConfig = {
  repos: [],
  triggerLabel: "ready-for-agent",
  pollIntervalSeconds: 60,
};

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // 'github' | 'linear' | 'discord' (kept as text + a unique constraint rather
    // than a pg enum so adding a provider needs no enum migration).
    provider: text("provider").notNull(),
    // Operator intent. A freshly-connected connector defaults ON — connecting a
    // tool self-configures (and enables) the heartbeat for it.
    enabled: boolean("enabled").notNull().default(true),
    // Write-only credential for credential-based connectors: the MCP API key
    // (linear / figma / context7) or the gateway secret (slack webhook URL,
    // telegram bot token). NEVER returned to the client in full — the read model
    // exposes only `hasSecret` + a masked display target. Null = not connected.
    // (Discord's legacy webhook stays on workspaces.discord_webhook_url.)
    secret: text("secret"),
    // Trigger config (repos / label / interval). Shape: ConnectorConfig.
    config: jsonb("config")
      .$type<ConnectorConfig>()
      .notNull()
      .default(CONNECTOR_CONFIG_DEFAULTS),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceProviderUnique: unique("connectors_workspace_provider_unique").on(
      t.workspaceId,
      t.provider
    ),
  })
);

export type Connector = typeof connectors.$inferSelect;
export type NewConnector = typeof connectors.$inferInsert;

/** The read model the console surface and the daemon both consume. */
export interface ConnectorRowView {
  provider: ConnectorProvider;
  enabled: boolean;
  config: ConnectorConfig;
  /**
   * Whether a credential is stored for this connector — a safe boolean the
   * console uses to derive connected state. The raw `secret` is NEVER projected
   * here; the daemon reads it via {@link getConnectorSecret} when it needs to
   * actually call the upstream.
   */
  hasSecret: boolean;
  updatedAt: string | null;
}
