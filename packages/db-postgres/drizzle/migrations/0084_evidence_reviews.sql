CREATE TABLE IF NOT EXISTS "change_record_prs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "record_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "repository_full_name" text NOT NULL,
  "pr_number" integer NOT NULL,
  "pr_url" text NOT NULL,
  "attached_by" text NOT NULL,
  "attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_record_prs" ADD CONSTRAINT "change_record_prs_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "change_record_prs" ADD CONSTRAINT "change_record_prs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "change_record_prs" ADD CONSTRAINT "change_record_prs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_record_prs_repository_pr_key" ON "change_record_prs" USING btree ("workspace_id","repository_id","pr_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_record_prs_record_idx" ON "change_record_prs" USING btree ("record_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "change_record_pr_revisions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "pr_attachment_id" uuid NOT NULL,
  "head_sha" text NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone,
  "source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_record_pr_revisions" ADD CONSTRAINT "change_record_pr_revisions_attachment_id_change_record_prs_id_fk" FOREIGN KEY ("pr_attachment_id") REFERENCES "public"."change_record_prs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_record_pr_revisions_attachment_head_key" ON "change_record_pr_revisions" USING btree ("pr_attachment_id","head_sha");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_record_pr_revisions_active_attachment_key" ON "change_record_pr_revisions" USING btree ("pr_attachment_id") WHERE "superseded_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_reviews" (
  "id" uuid PRIMARY KEY NOT NULL,
  "record_id" uuid NOT NULL,
  "pr_revision_id" uuid NOT NULL,
  "acceptance_contract_id" uuid NOT NULL,
  "acceptance_contract_version" integer NOT NULL,
  "head_sha" text NOT NULL,
  "diff_identity" jsonb NOT NULL,
  "overall_status" text NOT NULL,
  "static_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "test_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "independent_verifier" jsonb NOT NULL,
  "reviewability_result" jsonb NOT NULL,
  "environment_rung" text NOT NULL,
  "refusal_reason" text,
  "verifier_name" text NOT NULL,
  "verifier_version" text NOT NULL,
  "prompt_version" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_reviews" ADD CONSTRAINT "evidence_reviews_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "evidence_reviews" ADD CONSTRAINT "evidence_reviews_revision_id_change_record_pr_revisions_id_fk" FOREIGN KEY ("pr_revision_id") REFERENCES "public"."change_record_pr_revisions"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "evidence_reviews" ADD CONSTRAINT "evidence_reviews_contract_id_acceptance_contracts_id_fk" FOREIGN KEY ("acceptance_contract_id") REFERENCES "public"."acceptance_contracts"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_reviews_revision_key" ON "evidence_reviews" USING btree ("pr_revision_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_reviews_record_created_idx" ON "evidence_reviews" USING btree ("record_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_review_criteria" (
  "id" uuid PRIMARY KEY NOT NULL,
  "review_id" uuid NOT NULL,
  "criterion_id" text NOT NULL,
  "criterion_text_snapshot" text NOT NULL,
  "required" boolean NOT NULL,
  "status" text NOT NULL,
  "observed_behavior" text NOT NULL,
  "expected_behavior" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "runtime_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_review_criteria" ADD CONSTRAINT "evidence_review_criteria_review_id_evidence_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."evidence_reviews"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_review_criteria_review_criterion_key" ON "evidence_review_criteria" USING btree ("review_id","criterion_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_review_corrections" (
  "id" uuid PRIMARY KEY NOT NULL,
  "review_id" uuid NOT NULL,
  "criterion_id" text,
  "observed_behavior" text NOT NULL,
  "expected_behavior" text NOT NULL,
  "evidence_refs" jsonb NOT NULL,
  "reproduction_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "likely_affected_units" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "context_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scope_boundary" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_review_corrections" ADD CONSTRAINT "evidence_review_corrections_review_id_evidence_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."evidence_reviews"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_review_corrections_review_criterion_key" ON "evidence_review_corrections" USING btree ("review_id","criterion_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_review_correction_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "correction_id" uuid NOT NULL,
  "delivery_key" text NOT NULL,
  "channel" text NOT NULL,
  "target" jsonb NOT NULL,
  "review_revision_id" uuid NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "outcome" text DEFAULT 'queued' NOT NULL,
  "outcome_detail" text,
  "attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "evidence_review_correction_deliveries" ADD CONSTRAINT "evidence_review_correction_deliveries_correction_id_evidence_review_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."evidence_review_corrections"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "evidence_review_correction_deliveries" ADD CONSTRAINT "evidence_review_correction_deliveries_revision_id_change_record_pr_revisions_id_fk" FOREIGN KEY ("review_revision_id") REFERENCES "public"."change_record_pr_revisions"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_review_correction_deliveries_key" ON "evidence_review_correction_deliveries" USING btree ("correction_id","delivery_key");
