-- Stacked after #1736's reserved 0105 claim table. Before merge, rebase and
-- renumber after #1735's 0101/0102 plus #1737/0103 and #1738/0104.
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
    AND "candidate_fingerprint" ~ '^sha256:[a-f0-9]{64}$'
    AND "claim_token_sha256" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("candidate") = 'object'
    AND jsonb_typeof("profile") = 'object'
    AND jsonb_typeof("manager_custody") = 'object'
    AND "lease_expires_at" > "claimed_at"
    AND (("consumed_at" IS NULL) = ("observation_event_id" IS NULL))
  );
