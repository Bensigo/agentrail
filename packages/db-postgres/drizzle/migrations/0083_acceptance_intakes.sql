CREATE TABLE IF NOT EXISTS "acceptance_intakes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "origin_channel" text NOT NULL,
  "conversation_key" text NOT NULL,
  "source_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'collecting_context',
  "record_id" uuid REFERENCES "change_records"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_intakes_workspace_channel_conversation_key" ON "acceptance_intakes" ("workspace_id", "origin_channel", "conversation_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_intakes_record_key" ON "acceptance_intakes" ("record_id") WHERE "record_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_intake_messages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "intake_id" uuid NOT NULL REFERENCES "acceptance_intakes"("id") ON DELETE cascade,
  "source_key" text NOT NULL,
  "direction" text NOT NULL,
  "text" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_intake_messages_source_key" ON "acceptance_intake_messages" ("intake_id", "source_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_intake_messages_timeline_idx" ON "acceptance_intake_messages" ("intake_id", "created_at");
