-- #1584 — append-only review evidence for PR acceptance cost, including
-- explicit human review minutes and idempotent delivery replay boundaries.
CREATE TABLE IF NOT EXISTS "review_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "task_family" text,
  "delivery_id" text NOT NULL,
  "event_type" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "head_sha" text,
  "review_state" text,
  "actor_type" text,
  "additions" integer,
  "deletions" integer,
  "changed_files" integer,
  "human_review_minutes" numeric(10,2),
  "human_review_source" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "review_events" ADD CONSTRAINT "review_events_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_events_workspace_delivery_idx"
  ON "review_events" USING btree ("workspace_id", "delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_events_pr_occurred_idx"
  ON "review_events" USING btree ("workspace_id", "repo", "pr_number", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_events_family_occurred_idx"
  ON "review_events" USING btree ("workspace_id", "task_family", "occurred_at");
