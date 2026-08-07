ALTER TABLE "acceptance_evidence_review_requests"
  ADD COLUMN IF NOT EXISTS "worker_id" text;
--> statement-breakpoint
ALTER TABLE "acceptance_evidence_review_requests"
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "acceptance_evidence_review_requests"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "acceptance_evidence_review_requests"
  DROP CONSTRAINT IF EXISTS "acceptance_evidence_review_requests_status_check";
--> statement-breakpoint
ALTER TABLE "acceptance_evidence_review_requests"
  ADD CONSTRAINT "acceptance_evidence_review_requests_status_check"
  CHECK ("status" IN ('queued', 'claimed', 'completed', 'failed', 'superseded'));
