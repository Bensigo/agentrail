ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "merge_permission" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "workspace_grant_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "setting" text NOT NULL,
  "granted" boolean NOT NULL,
  "granted_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_grant_events_workspace_id_created_at_idx" ON "workspace_grant_events" USING btree ("workspace_id","created_at");
