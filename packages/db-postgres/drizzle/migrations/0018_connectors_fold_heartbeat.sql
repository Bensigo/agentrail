-- Connectors — per-workspace, per-provider control surface that ALSO configures
-- the Heartbeat. Folds in the former standalone heartbeat_config (#816): adding
-- a connector self-configures (and enables) the autonomous loop for it; the live
-- daemon reads connectors instead of a separate heartbeat config / CLI args.

CREATE TABLE IF NOT EXISTS "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{"repos":[],"triggerLabel":"ready-for-agent","pollIntervalSeconds":60}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_workspace_provider_unique" UNIQUE("workspace_id","provider")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Fold in the standalone heartbeat config: it is replaced by the per-connector
-- trigger config above.
DROP TABLE IF EXISTS "heartbeat_config";
