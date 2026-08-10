-- A stale GitHub API reconciliation may only restore the exact authority
-- revision it observed. Every later signed PR observation advances this value,
-- making the stale read fail closed under the shared PR advisory lock.
ALTER TABLE "change_records"
  ADD COLUMN IF NOT EXISTS "current_pr_head_authority_generation" integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "change_records"
    ADD CONSTRAINT "change_records_current_pr_head_authority_generation_check"
    CHECK ("current_pr_head_authority_generation" >= 0);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
