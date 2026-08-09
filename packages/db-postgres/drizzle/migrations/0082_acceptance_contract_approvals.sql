ALTER TABLE "jace_approvals"
  ADD COLUMN IF NOT EXISTS "acceptance_contract_id" uuid;

DO $$ BEGIN
  ALTER TABLE "jace_approvals"
    ADD CONSTRAINT "jace_approvals_acceptance_contract_id_acceptance_contracts_id_fk"
    FOREIGN KEY ("acceptance_contract_id")
    REFERENCES "public"."acceptance_contracts"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "jace_approvals_acceptance_contract_id_idx"
  ON "jace_approvals" USING btree ("acceptance_contract_id");
