-- Per-arm eval metrics from the offline eval harness reporter (issue #942).
-- One row per (eval run, arm). These are the falsifiable numbers the Agent
-- Operations Console shows in place of the always-zero context-quality
-- placeholders: solve-rate, dollars-per-solved-task, false-green rate.
--
-- dollars_per_solved and false_green_rate are NULLABLE on purpose: NULL means an
-- undefined denominator (no rep solved / no gate-passed run), which the reporter
-- distinguishes from a real 0.0. Never default these to 0.
--
-- Additive only. Unique on (workspace_id, run_id, arm) so re-posting a run
-- upserts rather than duplicating.
CREATE TABLE IF NOT EXISTS "eval_arm_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"arm" text NOT NULL,
	"repetitions" integer NOT NULL,
	"solved_count" integer NOT NULL,
	"failed_count" integer NOT NULL,
	"solve_rate" double precision NOT NULL,
	"spread" double precision NOT NULL,
	"total_input_tokens" integer NOT NULL,
	"total_output_tokens" integer NOT NULL,
	"total_cache_tokens" integer NOT NULL,
	"total_cache_creation_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"total_cost_usd" double precision NOT NULL,
	"dollars_per_solved" double precision,
	"gate_passed_count" integer DEFAULT 0 NOT NULL,
	"false_green_count" integer DEFAULT 0 NOT NULL,
	"false_green_rate" double precision,
	"strata" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_arm_metrics_workspace_run_arm_unique" UNIQUE("workspace_id","run_id","arm")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eval_arm_metrics" ADD CONSTRAINT "eval_arm_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
