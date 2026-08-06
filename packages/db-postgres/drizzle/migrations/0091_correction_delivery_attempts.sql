ALTER TABLE "evidence_review_correction_deliveries" ADD COLUMN "queued_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "evidence_review_correction_deliveries" SET "queued_at" = "attempted_at" WHERE "queued_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "evidence_review_correction_deliveries" ALTER COLUMN "queued_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "evidence_review_correction_deliveries" ALTER COLUMN "queued_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "evidence_review_correction_deliveries" ALTER COLUMN "attempted_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "evidence_review_correction_deliveries" ALTER COLUMN "attempt" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "evidence_review_correction_deliveries"
SET "attempt" = 0, "attempted_at" = NULL
WHERE "outcome" = 'queued' AND "attempt" = 1;
