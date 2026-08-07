CREATE TABLE IF NOT EXISTS "acceptance_context_pack_compilations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE restrict,
  "repository_ref" text NOT NULL,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "phase" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "worker_id" text,
  "claimed_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "context_pack_id" uuid REFERENCES "acceptance_context_packs"("id") ON DELETE restrict,
  "reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_context_pack_compilations_status_check"
    CHECK ("status" IN ('queued', 'claimed', 'compiled', 'not_proven', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_compilations_binding_key"
  ON "acceptance_context_pack_compilations" ("record_id", "acceptance_contract_version", "repository_id", "phase");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_compilations_queued_idx"
  ON "acceptance_context_pack_compilations" ("created_at") WHERE "status" = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_compilations_record_idx"
  ON "acceptance_context_pack_compilations" ("record_id", "created_at");
