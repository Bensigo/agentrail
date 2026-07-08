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
  // jace — the coordinator inbound gateway. A per-workspace `jace` row is the
  // kill switch: `enabled=false` HALTS inbound Jace conversations without
  // touching the factory. The factory (github intake / issue queue) is a
  // SEPARATE `github` provider row, so disabling `jace` cannot affect it.
  // (Free-text column, so this is a TS-union addition only — no migration.)
  "jace",
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
  /**
   * Telegram inbound webhook secret (#889). Generated per workspace at connect
   * time and passed to Telegram's `setWebhook` as `secret_token`; Telegram echoes
   * it in the `X-Telegram-Bot-Api-Secret-Token` header on every delivery so the
   * webhook route can authenticate the request. NOT the bot token (that stays in
   * the write-only `secret`); this is a low-value shared HMAC-style nonce kept in
   * config so the route can read it cheaply. Absent for other providers.
   */
  webhookSecret?: string;
  /**
   * Telegram inbound POLLING offset (getUpdates `offset` cursor). The local-dev
   * poller (`apps/console/scripts/telegram-poll.ts`) persists the last processed
   * `update_id + 1` here so a restart resumes past already-handled updates rather
   * than replaying them. Only the poller writes it; it is irrelevant to the
   * webhook (deployed) path. Absent until the poller has run. Other providers: absent.
   */
  telegramOffset?: number;
  /**
   * JACE CHANNEL-MIGRATION opt-in (#1047). Lives on the `jace` connector row and
   * flips the OUTBOUND Telegram run-outcome notify source from the legacy console
   * sender to Jace, so a "run failed" ping lands in a repliable thread. It is the
   * per-workspace cutover control — an EXPLICIT opt-in, DEFAULT OFF (absent), and
   * additional to the `jace` connector being enabled. Kept separate from the
   * `enabled` kill switch on purpose: merely enabling inbound Jace must NOT steal
   * Telegram notifications away from the legacy path (that would go dark before the
   * Jace-side delivery is deployed). Flip it true ONLY after verifying the new path
   * delivers exactly once, then retire the legacy sender (the cutover PR). Absent /
   * false on every other provider and pre-migration. See `jaceOwnsTelegramNotify`
   * and `apps/console/app/api/v1/runner/result/notify.ts`.
   */
  telegramNotify?: boolean;
  /**
   * JACE CHANNEL-MIGRATION opt-in for DISCORD (#1050). Lives on the `jace`
   * connector row and flips the OUTBOUND Discord run-outcome notify source from
   * the legacy console webhook sender (which posts to the workspace-level
   * `discord_webhook_url`) to Jace. Same contract as {@link telegramNotify}: an
   * EXPLICIT opt-in, DEFAULT OFF (absent), additional to the `jace` connector
   * being enabled, and kept separate from the `enabled` kill switch so enabling
   * inbound Jace never silently steals Discord notifications. Flip it true ONLY
   * after verifying the Jace path delivers exactly once, then retire the legacy
   * sender (the cutover PR). See `jaceOwnsDiscordNotify`.
   */
  discordNotify?: boolean;
  /**
   * JACE CHANNEL-MIGRATION opt-in for SLACK (#1050). Lives on the `jace`
   * connector row and routes the OUTBOUND Slack run-outcome notify through Jace.
   * Slack is GREENFIELD — there is NO legacy Slack console sender — so this opt-in
   * simply turns Jace-side Slack delivery ON; absent/false means no Slack
   * notification (not a legacy fallback). EXPLICIT opt-in, DEFAULT OFF, additional
   * to the `jace` connector being enabled. See `jaceOwnsSlackNotify`.
   */
  slackNotify?: boolean;
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
