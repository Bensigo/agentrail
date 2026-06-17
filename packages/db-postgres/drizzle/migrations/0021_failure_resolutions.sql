-- User-controlled "is this fixed?" state for failures. Failure events live in
-- ClickHouse (append-only); this mutable resolution state lives in Postgres,
-- keyed by failure_key (the failure fingerprint, or the event_id when there is
-- no fingerprint). Unique per (workspace, failure_key) so a toggle upserts.
CREATE TABLE IF NOT EXISTS "failure_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"failure_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"resolved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "failure_resolutions_workspace_key_unique" UNIQUE("workspace_id","failure_key")
);
--> statement-breakpoint
ALTER TABLE "failure_resolutions" ADD CONSTRAINT "failure_resolutions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
