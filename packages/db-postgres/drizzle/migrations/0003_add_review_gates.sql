CREATE TYPE "public"."review_gate_status" AS ENUM('passed', 'failed', 'pending');--> statement-breakpoint
CREATE TABLE "review_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"gate_name" text NOT NULL,
	"status" "review_gate_status" DEFAULT 'pending' NOT NULL,
	"conditions" jsonb DEFAULT '[]',
	"blocking_reasons" jsonb DEFAULT '[]',
	"evidence_refs" jsonb DEFAULT '[]',
	"evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_gates" ADD CONSTRAINT "review_gates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_gates" ADD CONSTRAINT "review_gates_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
