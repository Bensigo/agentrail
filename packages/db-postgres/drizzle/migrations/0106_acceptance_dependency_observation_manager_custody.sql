-- Stacked after direct MCP 0101/0102, Context Pack regeneration 0103,
-- exact-Pack Claude delivery 0104, and the pnpm claim table 0105.
ALTER TABLE "acceptance_dependency_observation_claims"
  ADD COLUMN IF NOT EXISTS "manager_custody" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "acceptance_dependency_observation_claims"
  DROP CONSTRAINT IF EXISTS "acceptance_dependency_observation_claims_custody_check";
--> statement-breakpoint
ALTER TABLE "acceptance_dependency_observation_claims"
  ADD CONSTRAINT "acceptance_dependency_observation_claims_custody_check" CHECK (
    "head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "acceptance_contract_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "compiled_pack_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "github_installation_identity_sha256" ~ '^[a-f0-9]{64}$'
    AND "candidate_fingerprint" ~ '^sha256:[a-f0-9]{64}$'
    AND "claim_token_sha256" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("candidate") = 'object'
    AND jsonb_typeof("profile") = 'object'
    AND jsonb_typeof("manager_custody") = 'object'
    AND "lease_expires_at" > "claimed_at"
    AND (("consumed_at" IS NULL) = ("observation_event_id" IS NULL))
  );
