-- #1389 — retry backoff + persisted attempt history for requeued queue
-- entries. Additive only: a nullable next_eligible_at column on
-- queue_entries (the claim-eligibility delay a requeued-after-failure entry
-- carries) plus a new queue_attempts table capturing one row per runner
-- outcome (timestamp, tier, outcome, error summary), so an escalated entry
-- explains itself and a deterministic failure no longer burns the whole
-- Budget Leash in minutes.
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "next_eligible_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_entry_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tier" integer NOT NULL,
	"outcome" text NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_attempts" ADD CONSTRAINT "queue_attempts_queue_entry_id_queue_entries_id_fk" FOREIGN KEY ("queue_entry_id") REFERENCES "public"."queue_entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_attempts" ADD CONSTRAINT "queue_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_attempts_queue_entry_id_created_at_idx" ON "queue_attempts" USING btree ("queue_entry_id","created_at");
