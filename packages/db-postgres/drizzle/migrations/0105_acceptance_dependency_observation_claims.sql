-- Merge-order reservation: #1735 owns 0101/0102, builder re-entry owns 0103,
-- and Context Pack regeneration owns 0104. Rebase/renumber only if that order
-- changes before merge.
CREATE TABLE IF NOT EXISTS "acceptance_dependency_observation_claims" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "head_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "acceptance_contract_sha256" text NOT NULL,
  "compiled_pack_id" uuid NOT NULL REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "compiled_pack_sha256" text NOT NULL,
  "candidate_fingerprint" text NOT NULL,
  "candidate" jsonb NOT NULL,
  "profile" jsonb NOT NULL,
  "claimed_by" text NOT NULL,
  "claim_token_sha256" text NOT NULL,
  "claimed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "lease_expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "observation_event_id" uuid REFERENCES "change_record_events"("id") ON DELETE restrict,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_dependency_observation_claims_custody_check" CHECK (
    "head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "acceptance_contract_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "compiled_pack_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "candidate_fingerprint" ~ '^sha256:[a-f0-9]{64}$'
    AND "claim_token_sha256" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("candidate") = 'object'
    AND jsonb_typeof("profile") = 'object'
    AND "lease_expires_at" > "claimed_at"
    AND (("consumed_at" IS NULL) = ("observation_event_id" IS NULL))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_dependency_observation_claims_occurrence_key"
  ON "acceptance_dependency_observation_claims" ("record_id", "head_cycle_id", "candidate_fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_dependency_observation_claims_workspace_lease_idx"
  ON "acceptance_dependency_observation_claims" ("workspace_id", "lease_expires_at");
