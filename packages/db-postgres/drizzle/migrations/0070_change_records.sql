-- Arc D Change Record storage (spec
-- docs/superpowers/specs/2026-07-31-change-record-design.md). This is the
-- flagless storage substrate only: canonical records plus append-only timeline
-- events. Routes, UI, PR-comment rendering, chat answers, and producer
-- adapters intentionally land in later slices.
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit generate`d
-- — the snapshot chain in drizzle/migrations/meta/ is intentionally incomplete
-- in this repo, and the recent 0066-0068 migrations use the same hand-authored
-- posture. Keep this idempotent: CREATE TABLE IF NOT EXISTS, guarded FKs, and
-- CREATE INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "change_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer,
	"pr_number" integer,
	"head_shas" text[] DEFAULT '{}'::text[] NOT NULL,
	"merged_sha" text,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "change_records" ADD CONSTRAINT "change_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_records_issue_key" ON "change_records" USING btree ("workspace_id","repo","issue_number") WHERE "change_records"."issue_number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_records_pr_key" ON "change_records" USING btree ("workspace_id","repo","pr_number") WHERE "change_records"."pr_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_records_workspace_repo_idx" ON "change_records" USING btree ("workspace_id","repo");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "change_record_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"stage" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"payload_ref" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "change_record_events" ADD CONSTRAINT "change_record_events_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_record_events_record_event_key" ON "change_record_events" USING btree ("record_id","event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_record_events_timeline_idx" ON "change_record_events" USING btree ("record_id","at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_record_events_stage_idx" ON "change_record_events" USING btree ("record_id","stage");
