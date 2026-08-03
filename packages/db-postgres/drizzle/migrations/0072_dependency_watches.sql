-- #1578 — tenant-scoped, observation-only dependency watch state.
-- This table is operator intent/cursor state. It never enters queue_entries.
CREATE TABLE IF NOT EXISTS "dependency_watches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "manifest_path" text DEFAULT 'package.json' NOT NULL,
  "lockfile_path" text DEFAULT 'pnpm-lock.yaml' NOT NULL,
  "selected_dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cadence_seconds" integer,
  "last_checked_sha" text,
  "selected_file_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "candidate_fingerprint" text,
  "status" text DEFAULT 'idle' NOT NULL,
  "error_code" text,
  "error_message" text,
  "last_trigger" text,
  "last_triggered_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone,
  "next_check_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dependency_watches" ADD CONSTRAINT "dependency_watches_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
  ALTER TABLE "dependency_watches" ADD CONSTRAINT "dependency_watches_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watches_workspace_repo_config_idx"
  ON "dependency_watches" USING btree ("workspace_id", "repository_id", "manifest_path", "lockfile_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_watches_due_idx"
  ON "dependency_watches" USING btree ("next_check_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_watches_workspace_idx"
  ON "dependency_watches" USING btree ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dependency_watch_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "watch_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "trigger" text NOT NULL,
  "baseline_sha" text,
  "selected_file_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "observation_key" text NOT NULL,
  "status" text NOT NULL,
  "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error_code" text,
  "error_message" text,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dependency_watch_observations" ADD CONSTRAINT "dependency_watch_observations_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
  ALTER TABLE "dependency_watch_observations" ADD CONSTRAINT "dependency_watch_observations_watch_id_dependency_watches_id_fk"
    FOREIGN KEY ("watch_id") REFERENCES "public"."dependency_watches"("id") ON DELETE cascade;
  ALTER TABLE "dependency_watch_observations" ADD CONSTRAINT "dependency_watch_observations_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watch_observations_workspace_repo_key_idx"
  ON "dependency_watch_observations" USING btree ("workspace_id", "repository_id", "observation_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_watch_observations_watch_observed_idx"
  ON "dependency_watch_observations" USING btree ("watch_id", "observed_at");
