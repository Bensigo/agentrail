ALTER TABLE "evidence_review_corrections"
  ADD COLUMN IF NOT EXISTS "concrete_impact" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "evidence_review_corrections"
  ADD COLUMN IF NOT EXISTS "required_correction" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "evidence_review_corrections"
  ADD COLUMN IF NOT EXISTS "reverification" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "evidence_review_corrections"
  ADD COLUMN IF NOT EXISTS "repair_path" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_builder_handoffs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "record_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "builder" text NOT NULL,
  "task_context_key" text NOT NULL,
  "branch_name" text NOT NULL,
  "acceptance_contract_id" uuid NOT NULL,
  "acceptance_contract_version" integer NOT NULL,
  "context_pack_id" uuid NOT NULL,
  "status" text DEFAULT 'handed_off' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "pr_attached_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "acceptance_builder_handoffs" ADD CONSTRAINT "acceptance_builder_handoffs_record_id_change_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."change_records"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "acceptance_builder_handoffs" ADD CONSTRAINT "acceptance_builder_handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "acceptance_builder_handoffs" ADD CONSTRAINT "acceptance_builder_handoffs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "acceptance_builder_handoffs" ADD CONSTRAINT "acceptance_builder_handoffs_contract_id_acceptance_contracts_id_fk" FOREIGN KEY ("acceptance_contract_id") REFERENCES "public"."acceptance_contracts"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "acceptance_builder_handoffs" ADD CONSTRAINT "acceptance_builder_handoffs_context_pack_id_acceptance_context_packs_id_fk" FOREIGN KEY ("context_pack_id") REFERENCES "public"."acceptance_context_packs"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_builder_handoffs_record_task_key" ON "acceptance_builder_handoffs" USING btree ("record_id","task_context_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_builder_handoffs_repository_branch_key" ON "acceptance_builder_handoffs" USING btree ("workspace_id","repository_id","branch_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_builder_handoffs_repository_branch_lookup_idx" ON "acceptance_builder_handoffs" USING btree ("workspace_id","repository_id","branch_name");
