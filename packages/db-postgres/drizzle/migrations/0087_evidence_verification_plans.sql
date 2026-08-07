CREATE TABLE IF NOT EXISTS "evidence_verification_plans" (
  "id" uuid PRIMARY KEY NOT NULL,
  "record_id" uuid NOT NULL,
  "pr_revision_id" uuid NOT NULL,
  "acceptance_contract_id" uuid NOT NULL,
  "acceptance_contract_version" integer NOT NULL,
  "criterion_id" text NOT NULL,
  "criterion_text_snapshot" text NOT NULL,
  "modality" text NOT NULL,
  "environment_id" text,
  "flow" text,
  "expected_behavior" text NOT NULL,
  "status" text NOT NULL,
  "not_testable_reason" text,
  "planned_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evidence_verification_plans_modality_check" CHECK ("modality" IN ('ui', 'api', 'job', 'data')),
  CONSTRAINT "evidence_verification_plans_status_check" CHECK ("status" IN ('planned', 'not_testable')),
  CONSTRAINT "evidence_verification_plans_planned_proof_check" CHECK (
    ("status" = 'not_testable' AND length(trim(coalesce("not_testable_reason", ''))) > 0)
    OR ("status" = 'planned' AND length(trim(coalesce("environment_id", ''))) > 0 AND length(trim(coalesce("flow", ''))) > 0)
  )
);
--> statement-breakpoint
ALTER TABLE "evidence_verification_plans" ADD CONSTRAINT "evidence_verification_plans_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "evidence_verification_plans" ADD CONSTRAINT "evidence_verification_plans_revision_id_change_record_pr_revisions_id_fk" FOREIGN KEY ("pr_revision_id") REFERENCES "public"."change_record_pr_revisions"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "evidence_verification_plans" ADD CONSTRAINT "evidence_verification_plans_contract_id_acceptance_contracts_id_fk" FOREIGN KEY ("acceptance_contract_id") REFERENCES "public"."acceptance_contracts"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_verification_plans_revision_criterion_key" ON "evidence_verification_plans" USING btree ("pr_revision_id","criterion_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_verification_plans_record_revision_idx" ON "evidence_verification_plans" USING btree ("record_id","pr_revision_id");
