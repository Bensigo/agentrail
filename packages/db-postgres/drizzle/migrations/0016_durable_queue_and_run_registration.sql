-- Durable Issue Queue + resumable run-registration (MVP durable-queue).
-- Additive only: new queue_source enum, new queue_entries table, and new
-- nullable columns on runs so a killed run can be resumed.

DO $$ BEGIN
 CREATE TYPE "public"."queue_source" AS ENUM('cli', 'github', 'linear');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" "queue_source" NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tier" integer DEFAULT 0 NOT NULL,
	"remaining_budget" integer DEFAULT 2 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"blocked_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "queue_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "phase" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "cost_usd" double precision DEFAULT 0;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
