-- #1579 — keep the candidate fingerprint separate from the watch observation key.
ALTER TABLE "dependency_upgrade_contracts"
  ADD COLUMN IF NOT EXISTS "observation_key" text;

--> statement-breakpoint
UPDATE "dependency_upgrade_contracts"
  SET "observation_key" = COALESCE("observation_key", "candidate_fingerprint");

--> statement-breakpoint
ALTER TABLE "dependency_upgrade_contracts"
  ALTER COLUMN "observation_key" SET NOT NULL;
