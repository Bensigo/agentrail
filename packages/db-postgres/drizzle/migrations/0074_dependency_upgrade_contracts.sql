-- #1579 — candidate-to-contract alignment boundary and append-only decisions.
CREATE TABLE IF NOT EXISTS "dependency_upgrade_contracts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "watch_id" uuid NOT NULL,
  "candidate_fingerprint" text NOT NULL,
  "package_name" text NOT NULL,
  "dependency_kind" text NOT NULL,
  "specifier" text NOT NULL,
  "current_version" text NOT NULL,
  "target_version" text NOT NULL,
  "manifest_path" text NOT NULL,
  "lockfile_path" text NOT NULL,
  "baseline_sha" text NOT NULL,
  "proposal" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'proposed',
  "approval_id" uuid,
  "issue_url" text,
  "issue_number" text,
  "last_error" text,
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dependency_upgrade_contracts" ADD CONSTRAINT "dependency_upgrade_contracts_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
  ALTER TABLE "dependency_upgrade_contracts" ADD CONSTRAINT "dependency_upgrade_contracts_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade;
  ALTER TABLE "dependency_upgrade_contracts" ADD CONSTRAINT "dependency_upgrade_contracts_watch_id_dependency_watches_id_fk"
    FOREIGN KEY ("watch_id") REFERENCES "public"."dependency_watches"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_upgrade_contracts_candidate_idx"
  ON "dependency_upgrade_contracts" USING btree ("workspace_id", "candidate_fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_upgrade_contracts_workspace_state_idx"
  ON "dependency_upgrade_contracts" USING btree ("workspace_id", "state", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_upgrade_contracts_watch_idx"
  ON "dependency_upgrade_contracts" USING btree ("watch_id");
--> statement-breakpoint
ALTER TABLE "jace_approvals" ADD COLUMN IF NOT EXISTS "dependency_contract_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jace_approvals" ADD CONSTRAINT "jace_approvals_dependency_contract_id_dependency_upgrade_contracts_id_fk"
    FOREIGN KEY ("dependency_contract_id") REFERENCES "public"."dependency_upgrade_contracts"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dependency_upgrade_contract_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "contract_id" uuid NOT NULL,
  "candidate_fingerprint" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "decision" text NOT NULL,
  "approval_id" uuid,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dependency_upgrade_contract_events" ADD CONSTRAINT "dependency_upgrade_contract_events_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
  ALTER TABLE "dependency_upgrade_contract_events" ADD CONSTRAINT "dependency_upgrade_contract_events_contract_id_dependency_upgrade_contracts_id_fk"
    FOREIGN KEY ("contract_id") REFERENCES "public"."dependency_upgrade_contracts"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_upgrade_contract_events_contract_idx"
  ON "dependency_upgrade_contract_events" USING btree ("contract_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dependency_upgrade_contract_events_workspace_idx"
  ON "dependency_upgrade_contract_events" USING btree ("workspace_id", "occurred_at");
