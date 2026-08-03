-- Arc E Judgment Ledger storage (spec
-- docs/superpowers/specs/2026-07-31-judgment-ledger-design.md). This is the
-- bounded E1 capture substrate only: typed append-only judgment events scoped
-- to a workspace/repo. Routes, producers, consumers, calibration, and UI
-- intentionally land in later slices.
--
-- NOTE ON THIS FILE'S PROVENANCE: hand-authored, NOT `drizzle-kit generate`d
-- — the snapshot chain in drizzle/migrations/meta/ is intentionally incomplete
-- in this repo, and the recent 0066-0070 migrations use the same hand-authored
-- posture. Keep this idempotent: CREATE TABLE IF NOT EXISTS, guarded FKs, and
-- CREATE INDEX IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "judgment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"event_key" text NOT NULL,
	"type" text NOT NULL,
	"refs" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_ref" jsonb NOT NULL,
	"source_ref" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judgment_events_type_check" CHECK ("type" IN ('review_outcome', 'requirement_correction', 'rejected_approach', 'false_green', 'missed_check'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "judgment_events" ADD CONSTRAINT "judgment_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "judgment_events_workspace_repo_event_key" ON "judgment_events" USING btree ("workspace_id","repo","event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_events_workspace_repo_occurred_idx" ON "judgment_events" USING btree ("workspace_id","repo","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_events_workspace_repo_type_idx" ON "judgment_events" USING btree ("workspace_id","repo","type");
