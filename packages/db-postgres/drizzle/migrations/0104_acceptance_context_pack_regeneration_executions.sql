CREATE TABLE IF NOT EXISTS "acceptance_context_pack_regeneration_executions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "request_event_id" uuid NOT NULL REFERENCES "change_record_events"("id") ON DELETE restrict,
  "request_event_key" text NOT NULL,
  "source_snapshot_id" uuid NOT NULL REFERENCES "acceptance_context_pack_snapshots"("id") ON DELETE restrict,
  "prior_compiled_pack_id" uuid NOT NULL REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "acceptance_contract_sha256" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 1,
  "claimed_by" text,
  "lease_token_sha256" text,
  "lease_expires_at" timestamp with time zone,
  "replacement_compiled_pack_id" uuid REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "outcome_reason" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_context_pack_regeneration_executions_binding_check" CHECK (
    char_length("request_event_key") BETWEEN 1 AND 1024
    AND char_length("repo") BETWEEN 3 AND 201
    AND "repo" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    AND "pr_number" > 0
    AND "head_sha" ~ '^[a-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "acceptance_contract_sha256" ~ '^[a-f0-9]{64}$'
    AND "reason" IN ('stale', 'inadequate')
    AND "max_attempts" = 1
    AND "attempt_count" BETWEEN 0 AND "max_attempts"
  ),
  CONSTRAINT "acceptance_context_pack_regeneration_executions_state_check" CHECK (
    "status" IN ('queued', 'running', 'replaced', 'unchanged', 'not_current', 'not_proven', 'held')
    AND (("status" = 'running') = ("claimed_by" IS NOT NULL))
    AND (("status" = 'running') = ("lease_token_sha256" IS NOT NULL))
    AND (("status" = 'running') = ("lease_expires_at" IS NOT NULL))
    AND ("lease_token_sha256" IS NULL OR "lease_token_sha256" ~ '^[a-f0-9]{64}$')
    AND (("status" IN ('queued', 'running')) = ("completed_at" IS NULL))
    AND (("status" NOT IN ('queued', 'running')) = ("outcome_reason" IS NOT NULL))
    AND (("status" = 'replaced') = ("replacement_compiled_pack_id" IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_request_key"
  ON "acceptance_context_pack_regeneration_executions" ("request_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_claim_idx"
  ON "acceptance_context_pack_regeneration_executions" ("status", "lease_expires_at", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_record_idx"
  ON "acceptance_context_pack_regeneration_executions" ("workspace_id", "record_id", "created_at");
