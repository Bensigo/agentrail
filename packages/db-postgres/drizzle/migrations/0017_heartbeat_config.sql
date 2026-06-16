-- Heartbeat trigger configuration (MVP, #4).
-- Additive only: one heartbeat_config row per workspace. The console writes it
-- (enable/disable, interval, label); the live daemon reads it. Absence of a row
-- means defaults (disabled, 60s, 'ready-for-agent').

CREATE TABLE IF NOT EXISTS "heartbeat_config" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"poll_interval_seconds" integer DEFAULT 60 NOT NULL,
	"trigger_label" text DEFAULT 'ready-for-agent' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heartbeat_config" ADD CONSTRAINT "heartbeat_config_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
