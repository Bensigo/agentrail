ALTER TABLE "evidence_verification_executions" DROP CONSTRAINT "evidence_verification_executions_status_check";
--> statement-breakpoint
ALTER TABLE "evidence_verification_executions" ADD COLUMN "observed_behavior" text;
--> statement-breakpoint
ALTER TABLE "evidence_verification_executions" ADD COLUMN "artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "evidence_verification_executions" ADD COLUMN "result_reason" text;
--> statement-breakpoint
ALTER TABLE "evidence_verification_executions" ADD CONSTRAINT "evidence_verification_executions_status_check" CHECK ("status" IN ('queued', 'claimed', 'proven', 'not_proven', 'not_testable', 'failed'));
