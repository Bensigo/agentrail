-- Jace as a GitHub App — identity design (spec
-- docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §5).
-- Additive only: five nullable columns on `workspaces` carrying the
-- workspace's bound GitHub App installation (id + captured account
-- login/type) and the single-use install-flow state token (house
-- connect-link pattern — mirrors chat_identities.link_token /
-- .signup_token). Nothing here touches an existing table's data or an
-- existing column's type; every existing row gets NULLs, which
-- `getInstallationToken` treats as "GitHub not connected".
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit
-- generate`d — `pnpm --filter @agentrail/db-postgres generate` errors
-- outright in this checkout (confirmed on this branch, unrelated to this
-- change): the snapshot chain in `drizzle/migrations/meta/` only has
-- entries for migrations 0000-0003 even though the journal
-- (`meta/_journal.json`) runs through migration 0045, so `generate` has no
-- accurate baseline to diff against and drizzle-kit's enum-conflict
-- resolver falls back to an interactive prompt that fails immediately
-- outside a TTY (`Interactive prompts require a TTY terminal`). This is the
-- same pre-existing, documented gap called out in 0042_goal_loop.sql and
-- 0043_wallet_engine.sql's own provenance notes — migrations 0042 through
-- 0045 are all hand-authored for the same reason. This file follows the
-- exact idempotent statement shape those migrations established
-- (`ADD COLUMN IF NOT EXISTS`), so it is safe to re-run exactly like its
-- siblings.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "github_installation_id" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "github_installation_account_login" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "github_installation_account_type" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "github_install_state" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "github_install_state_expires_at" timestamp with time zone;
