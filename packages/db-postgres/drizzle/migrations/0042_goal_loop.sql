-- Issue #1289 (Jace goal loop, PRD docs/prd/jace-goal-loop.md, locked
-- 2026-07-10). Additive only: the `jace_goal_loop` rollout-safety flag on
-- `workspaces` (default false), plus the new `goals` + `goal_events`
-- tables. Nothing here touches an existing table's data or an existing
-- column's type.
--
-- NOTE ON THIS FILE'S PROVENANCE: this migration is hand-authored, not
-- `drizzle-kit generate`d. `drizzle-kit generate` in this checkout only has
-- snapshot files for migrations 0000-0003
-- (packages/db-postgres/drizzle/migrations/meta/*_snapshot.json) even
-- though the journal (meta/_journal.json) runs through migration 0040 —
-- the snapshot chain is missing entries for every migration from 0004
-- onward, a PRE-EXISTING gap unrelated to this feature. Running `generate`
-- against that broken chain diffs against a stale schema and is not safe to
-- trust for this change, so this file is written by hand, following the
-- exact statement shapes (`ADD COLUMN IF NOT EXISTS`, enum `CREATE TYPE`
-- guarded by a `DO $$ ... EXCEPTION WHEN duplicate_object` block, `CREATE
-- TABLE IF NOT EXISTS`, FK constraints in their own guarded `DO $$` block)
-- every other migration in this directory already uses, so this migration
-- is idempotent and safe to re-run exactly like its siblings.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "jace_goal_loop" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."goal_status" AS ENUM('active', 'reached', 'leashed', 'paused', 'abandoned');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."goal_check_type" AS ENUM('metric', 'command');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."goal_event_type" AS ENUM('issue_filed', 'outcome_recorded', 'status_changed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"objective" text NOT NULL,
	"slug" text NOT NULL,
	"check_type" "goal_check_type" DEFAULT 'metric' NOT NULL,
	"check_metric" text,
	"check_threshold" integer,
	"check_command" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"max_issues" integer DEFAULT 10 NOT NULL,
	"max_spend_usd" numeric(10, 2) DEFAULT '50' NOT NULL,
	"issues_filed" integer DEFAULT 0 NOT NULL,
	"spend_usd" numeric(10, 2) DEFAULT '0' NOT NULL,
	"stuck_threshold" integer DEFAULT 2 NOT NULL,
	"consecutive_non_green" integer DEFAULT 0 NOT NULL,
	"green_count" integer DEFAULT 0 NOT NULL,
	"created_by_eve_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goals" ADD CONSTRAINT "goals_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_workspace_id_idx" ON "goals" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_workspace_status_idx" ON "goals" USING btree ("workspace_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_workspace_slug_idx" ON "goals" USING btree ("workspace_id","slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "goal_event_type" NOT NULL,
	"issue_external_id" text,
	"outcome" text,
	"cost_usd" numeric(10, 2),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goal_events" ADD CONSTRAINT "goal_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_events_goal_id_idx" ON "goal_events" USING btree ("goal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_events_workspace_id_idx" ON "goal_events" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_events_issue_external_id_idx" ON "goal_events" USING btree ("workspace_id","issue_external_id");
