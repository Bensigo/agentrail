-- Slack multi-workspace install, Task 1 (spec
-- docs/superpowers/specs/2026-07-29-slack-multi-workspace-design.md §1). One
-- row per Slack team, keyed by Slack's own team_id — NOT workspace_id, and
-- deliberately no workspace_id column at all (see schema/slack_installations.ts
-- for the full WHY: modelled on chat_identities, not connectors, so an
-- install can be stored before any AgentRail workspace exists to connect it
-- to).
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit
-- generate`d, following 0062_billing_accounts.sql's idempotent statement
-- shapes (`CREATE TABLE IF NOT EXISTS`) so it is safe to re-run.
CREATE TABLE IF NOT EXISTS "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_token" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"installed_by_slack_user_id" text,
	"scopes" text,
	"enterprise_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installations_team_id_unique" UNIQUE("team_id")
);
