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
  // observability — Task 7 (debugging design spec): railway, the first
  // EXTERNAL credentialed evidence provider (`lib/evidence/railway.ts`).
  // Stores a per-workspace account/team token in `secret` exactly like
  // linear/figma/context7 above; its non-secret companion field is
  // `config.railwayProjectId` (see {@link ConnectorConfig.railwayProjectId}).
  // Same precedent as `jace`: a free-text column, so this is a TS-union
  // addition only — no migration.
  "railway",
  // observability — Task P2 (Evidence Providers Wave 2): langfuse, the
  // first Wave-2 provider (`apps/console/lib/evidence/langfuse.ts`). Stores
  // a COMPOSITE `pk-lf-…:sk-lf-…` credential in `secret` (see
  // `apps/console/lib/evidence/composite-secret.ts`), same single-column
  // convention as every other provider here; its non-secret companion
  // field is `config.langfuseHost` (already added by Task P0 — see
  // {@link ConnectorConfig.langfuseHost}). Same precedent as `railway`: a
  // free-text column, so this is a TS-union addition only — no migration.
  "langfuse",
  // observability — Task P3 (Evidence Providers Wave 2): sentry, the second
  // Wave-2 provider (`apps/console/lib/evidence/sentry.ts`). Stores a
  // SINGLE org/user auth token in `secret` (no composite split, unlike
  // `langfuse` above — same single-column shape as `railway`); its two
  // non-secret companion fields are `config.sentryOrg` + `config.sentryProject`
  // (already added by Task P0 — see {@link ConnectorConfig.sentryOrg}).
  // Same precedent as `railway`/`langfuse`: a free-text column, so this is
  // a TS-union addition only — no migration.
  "sentry",
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
   * Discord / Slack gateway: the channel id Jace's NATIVE Eve channel posts to
   * (the `{ channelId }` proactive-`receive` target). Non-secret display field —
   * the bot credentials live in Jace's env, never here. This is the destination
   * the Jace-migrated outbound path needs (the legacy Discord path uses the
   * workspace-level webhook secret instead). Absent until a workspace configures
   * the Jace-native channel; the run-outcome route rejects a push without it.
   * Absent for other providers. See `apps/jace/agent/channels/run-outcome.ts`.
   */
  channelId?: string;
  /**
   * Inbound webhook secret (#889, extended #1233). Two independent uses, keyed
   * by which provider's connector row it lives on (each provider gets its own
   * row, so there is no collision):
   *   - Telegram: generated per workspace at connect time and passed to
   *     Telegram's `setWebhook` as `secret_token`; Telegram echoes it in the
   *     `X-Telegram-Bot-Api-Secret-Token` header on every delivery so the
   *     webhook route can authenticate the request. NOT the bot token (that
   *     stays in the write-only `secret`).
   *   - GitHub (#1233 onboarding wizard): generated by the `/setup` wizard's
   *     "Create webhook" action and passed to the GitHub API when
   *     auto-creating the repo webhook (`config.secret`) that delivers to
   *     `/api/v1/connectors/github/webhook`. Its presence (alongside ≥1 repo)
   *     is the pure signal the onboarding-steps derivation reads as "GitHub
   *     step complete" — see `apps/console/lib/onboarding-steps.ts`. Stored
   *     even when the live GitHub API call fails, so the `/setup` wizard can
   *     always show the same secret in its manual-setup fallback instructions.
   * A low-value shared HMAC-style nonce either way — kept in config (not the
   * encrypted `secret` column) so routes can read it cheaply. Absent for other
   * providers.
   */
  webhookSecret?: string;
  /**
   * Onboarding wizard: the operator chose "Skip for now" on the wizard's
   * `message-jace` step for this workspace (three-step rebuild — owner
   * ruling: "connect to github / invite team / message Jace ... the rest is
   * redundant"; `message-jace` replaced the old two-step "Connect a
   * channel" + "Say hi to Jace" split). Field name unchanged from the
   * original Connect-a-channel step this superseded — same mechanism, same
   * telegram row, so an existing skip survives the rename with zero data
   * loss. Lives on the `telegram` connector row (the only channel the
   * wizard offers today) so the skip is remembered per workspace without a
   * new table — `deriveOnboardingSteps` reads it, but only when
   * `message-jace` is NOT already complete (a real connect/reply always
   * outranks a stale skip). ISO timestamp of when skipped, or absent if
   * never skipped / already complete.
   */
  channelSkippedAt?: string;
  /**
   * Onboarding wizard (three-step rebuild, all steps individually
   * skippable): the operator chose "Skip for now" on the Connect-GitHub
   * step for this workspace. Lives on the `github` connector row itself —
   * the most natural per-workspace home for it — mirroring
   * `channelSkippedAt`'s precedent so no new table is needed.
   * `deriveOnboardingSteps` reads it, but only when github is NOT already
   * connected (≥1 repo + a webhook secret always outranks a stale skip).
   * ISO timestamp of when skipped, or absent if never skipped / already
   * connected.
   */
  githubSkippedAt?: string;
  /**
   * Onboarding wizard (three-step rebuild, all steps individually
   * skippable): the operator chose "Skip for now" on the Invite-team step
   * for this workspace. Invite-team has no connector of its own to live on
   * — rather than add a new table (or a new column elsewhere) for one
   * flag, it piggybacks on the `github` connector row alongside
   * `githubSkippedAt` above, since that row already exists per workspace by
   * the time onboarding is in progress. `deriveOnboardingSteps` reads it,
   * but only when the invite count is still zero (reaching a teammate
   * always outranks a stale skip). ISO timestamp of when skipped, or absent
   * if never skipped / already reached a teammate.
   */
  inviteTeamSkippedAt?: string;
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
  /**
   * JACE CHANNEL-MIGRATION opt-in for iMESSAGE (#1100). Lives on the `jace`
   * connector row and routes the OUTBOUND iMessage run-outcome notify through
   * Jace. iMessage is GREENFIELD — there is NO legacy iMessage console sender —
   * because the channel has no official bot/webhook API and can only be driven
   * through a Messages BRIDGE running on a Mac (self-hosted BlueBubbles or a
   * commercial API like Sendblue/LoopMessage), which lives entirely Jace-side. So
   * this opt-in simply turns Jace-side iMessage delivery ON; absent/false means no
   * iMessage notification (not a legacy fallback). EXPLICIT opt-in, DEFAULT OFF,
   * additional to the `jace` connector being enabled. Flipping it true is a no-op
   * until the bridge is chosen (AC0) and the Jace-side delivery handler ships
   * (blocked on the deployed sidecar, #1038). See `jaceOwnsIMessageNotify`.
   */
  imessageNotify?: boolean;
  /**
   * Railway evidence connector (Task 7, debugging design spec): the
   * workspace's Railway project id, scoping `lib/evidence/railway.ts`'s
   * `deployments`/`deploymentLogs` GraphQL queries. Non-secret display
   * field — the account/team token is the secret (this column's sibling).
   * Saved via the connectors PUT (config path,
   * `api/v1/workspaces/[workspaceId]/connectors/route.ts`), NOT the secret
   * route — the connect card's expanded form posts token and project id to
   * two different routes on connect (`connectors-panel.tsx`'s
   * `SecretManage`). Absent until the workspace connects Railway; the
   * railway adapter degrades `config_missing` when absent (its own
   * doc-comment explains why that reason, not `bad_request`). Absent for
   * every other provider.
   */
  railwayProjectId?: string;
  // Evidence Providers Wave 2 (Task P0, `.superpowers/sdd/plan-providers.md`)
  // — non-secret companion fields for the wave's seven providers, ALL added
  // at once here so P2–P8 never touch this schema package again. Each
  // mirrors `railwayProjectId` above (Task 7): optional string, saved via
  // the connectors PUT (config path — now generic, see
  // `connector-helpers.ts`'s `ConnectorConnectMeta.extraConfigFields` and
  // `extraConfigFieldKeys`), never a secret (the provider's actual
  // credential lives in `connectors.secret`, possibly composite — see
  // `apps/console/lib/evidence/composite-secret.ts`). Every field is absent
  // until its provider's connect form is used; no provider task after P0
  // needs to add a new field here.
  /** Langfuse: base URL for the workspace's Langfuse deployment/region
   * (`https://cloud.langfuse.com`, `https://jp.cloud.langfuse.com`, or a
   * self-host origin). */
  langfuseHost?: string;
  /** Sentry: the organization slug the workspace's project(s) live under. */
  sentryOrg?: string;
  /** Sentry: the project slug within {@link sentryOrg}. */
  sentryProject?: string;
  /** Datadog: the account's site (`datadoghq.com`, `us3.datadoghq.com`,
   * `us5.datadoghq.com`, `datadoghq.eu`, …). */
  datadogSite?: string;
  /** Prometheus: the base URL of the workspace's Prometheus (or
   * Prometheus-compatible) query endpoint. */
  prometheusUrl?: string;
  /** Grafana: the base URL of the workspace's Grafana instance. */
  grafanaUrl?: string;
  /** Vercel: the team id scoping the workspace's deployments (optional — a
   * personal-account Vercel project has none). */
  vercelTeamId?: string;
  /** Vercel: the project id the debugging investigator reads deployments
   * from. */
  vercelProjectId?: string;
  /** Cloudflare: the zone id scoping the workspace's analytics/security
   * queries. */
  cloudflareZoneId?: string;
  /** Cloudflare: the account id (needed alongside the zone id for some
   * GraphQL analytics queries). */
  cloudflareAccountId?: string;
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
