CREATE TABLE IF NOT EXISTS "evidence_verification_artifacts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "verification_plan_id" uuid NOT NULL,
  "artifact_key" text NOT NULL,
  "content_type" text NOT NULL,
  "content_sha256" text NOT NULL,
  "collected_by" text NOT NULL,
  "collected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evidence_verification_artifacts_content_type_check" CHECK ("content_type" IN ('image/png', 'image/jpeg'))
);
--> statement-breakpoint
ALTER TABLE "evidence_verification_artifacts" ADD CONSTRAINT "evidence_verification_artifacts_plan_id_evidence_verification_plans_id_fk" FOREIGN KEY ("verification_plan_id") REFERENCES "public"."evidence_verification_plans"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_verification_artifacts_plan_collected_idx" ON "evidence_verification_artifacts" USING btree ("verification_plan_id","collected_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_verification_artifacts_key" ON "evidence_verification_artifacts" USING btree ("artifact_key");
