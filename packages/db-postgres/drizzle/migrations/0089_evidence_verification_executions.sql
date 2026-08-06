CREATE TABLE IF NOT EXISTS "evidence_verification_executions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "verification_plan_id" uuid NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "worker_id" text,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evidence_verification_executions_status_check" CHECK ("status" IN ('queued', 'claimed', 'not_proven', 'not_testable', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "evidence_verification_executions" ADD CONSTRAINT "evidence_verification_executions_plan_id_evidence_verification_plans_id_fk" FOREIGN KEY ("verification_plan_id") REFERENCES "public"."evidence_verification_plans"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_verification_executions_plan_key" ON "evidence_verification_executions" USING btree ("verification_plan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_verification_executions_queued_idx" ON "evidence_verification_executions" USING btree ("created_at") WHERE "status" = 'queued';
