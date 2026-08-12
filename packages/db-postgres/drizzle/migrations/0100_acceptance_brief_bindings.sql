CREATE TABLE IF NOT EXISTS "acceptance_brief_bindings" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE restrict,
  "brief_id" uuid NOT NULL REFERENCES "briefs"("id") ON DELETE restrict,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "brief_snapshot" jsonb NOT NULL,
  "brief_snapshot_sha256" text NOT NULL,
  "provenance" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_brief_bindings_contract_version_check"
    CHECK ("acceptance_contract_version" > 0),
  CONSTRAINT "acceptance_brief_bindings_snapshot_hash_check"
    CHECK ("brief_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_brief_bindings_record_key"
  ON "acceptance_brief_bindings" ("record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_brief_bindings_contract_idx"
  ON "acceptance_brief_bindings" ("acceptance_contract_id", "acceptance_contract_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_brief_bindings_workspace_record_idx"
  ON "acceptance_brief_bindings" ("workspace_id", "record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_brief_bindings_workspace_brief_idx"
  ON "acceptance_brief_bindings" ("workspace_id", "brief_id");
