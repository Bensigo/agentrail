-- Reviewer of Record: the review_jobs queue (Arc B §2, spec
-- docs/superpowers/specs/2026-07-31-reviewer-of-record-design.md). Every PR
-- event on a connected repo becomes one row here; a headless Jace worker
-- claims rows (SKIP LOCKED, in a later task's query layer) and posts the one
-- review of record. `id` is caller-supplied (deterministic uuid5 of
-- workspace/repo/pr/head, computed at the call site — the `entryId`
-- precedent, see schema/review_jobs.ts) — deliberately no DEFAULT, so this
-- migration does not stamp one either. Naming note: the existing
-- `review_gates` table is a DIFFERENT, unrelated concept (per-run
-- CI+advisory telemetry) — this is "review job", never "review gate".
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit
-- generate`d — `pnpm --filter @agentrail/db-postgres generate` errors
-- outright in this checkout: the snapshot chain in `drizzle/migrations/meta/`
-- only has entries for migrations 0000-0003 even though the journal
-- (`meta/_journal.json`) runs through migration 0064, so `generate` has no
-- accurate baseline to diff against and drizzle-kit's enum-conflict resolver
-- falls back to an interactive prompt that fails immediately outside a TTY
-- (`Interactive prompts require a TTY terminal`). This is the same
-- pre-existing, documented gap called out in 0046_github_app_installation.sql
-- and 0064_slack_installations.sql's own provenance notes. This file follows
-- those migrations' idempotent statement shapes (`CREATE TABLE IF NOT
-- EXISTS`, FK constraints in their own guarded `DO $$ ... EXCEPTION WHEN
-- duplicate_object` blocks, `CREATE INDEX IF NOT EXISTS`), so it is safe to
-- re-run.
CREATE TABLE IF NOT EXISTS "review_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"event" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"next_eligible_at" timestamp with time zone,
	"posted_review_url" text,
	"verdict" text,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_jobs_queued_idx" ON "review_jobs" USING btree ("state") WHERE "review_jobs"."state" = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_jobs_pr_idx" ON "review_jobs" USING btree ("workspace_id","repo","pr_number");
