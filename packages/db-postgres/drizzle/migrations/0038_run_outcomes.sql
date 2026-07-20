-- #1338 PR① (model-selection learning loop — the FUEL). Additive only:
-- a nullable task_type column on queue_entries (denormalized off the
-- alignment brief's classifier output at brief-confirm time), plus a new
-- run_outcomes table capturing one row per queue-entry terminal transition:
-- (task_type, execute_model) -> outcome + cost. CAPTURE ONLY — nothing reads
-- this table yet to change which model runs.
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "task_type" text;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."run_outcome" AS ENUM('success', 'human_review', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_entry_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_type" text,
	"execute_model" text,
	"outcome" "run_outcome" NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_outcomes_queue_entry_id_unique" UNIQUE("queue_entry_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_outcomes" ADD CONSTRAINT "run_outcomes_queue_entry_id_queue_entries_id_fk" FOREIGN KEY ("queue_entry_id") REFERENCES "public"."queue_entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "run_outcomes" ADD CONSTRAINT "run_outcomes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_outcomes_workspace_id_idx" ON "run_outcomes" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_outcomes_task_type_model_idx" ON "run_outcomes" USING btree ("task_type","execute_model");
