import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Slack installations — one row per Slack team (spec §1,
 * docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md). Modelled
 * on `chat_identities`, NOT `connectors`: `connectors.workspace_id` is NOT
 * NULL with a cascading FK, so it structurally cannot hold an install that
 * happens BEFORE any AgentRail workspace exists — which is the normal Slack
 * case (someone installs the app into their Slack, then connects it to an
 * AgentRail workspace later). This table carries no `workspace_id` at all;
 * `team_id` (Slack's own workspace id) is the natural key, exactly like
 * `chat_identities`' (platform, platform_user_id).
 *
 * `bot_token` is encrypted at rest via the existing `encryptSecret`
 * (AES-256-GCM, key from `CONNECTOR_SECRET_KEY`, `enc:v1:` stored format) —
 * see `queries/slack_installations.ts` for the encrypt-on-write /
 * decrypt-on-read boundary. No new crypto scheme.
 *
 * `bot_user_id` is per-install: mention detection compares against THIS,
 * replacing the single-tenant `SLACK_BOT_USER_ID` env var (spec §1).
 *
 * `revoked_at` is set on Slack's `app_uninstalled` event and NEVER causes a
 * row delete — a reinstall (`upsertSlackInstallation`) clears it back to
 * null, so an uninstall/reinstall cycle stays auditable instead of losing
 * history. `getSlackInstallation` treats a revoked row the same as an
 * absent one (returns null), so every caller fails closed without having to
 * remember the revoked check itself.
 *
 * `enterprise_id` is recorded but not supported — v1 refuses Enterprise Grid
 * org-wide installs (spec §5); this column is diagnostic only.
 */
export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id").notNull(),
    teamName: text("team_name"),
    botToken: text("bot_token").notNull(),
    botUserId: text("bot_user_id").notNull(),
    installedBySlackUserId: text("installed_by_slack_user_id"),
    scopes: text("scopes"),
    enterpriseId: text("enterprise_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    teamIdUnique: unique("slack_installations_team_id_unique").on(t.teamId),
  })
);

export type SlackInstallationRow = typeof slackInstallations.$inferSelect;
