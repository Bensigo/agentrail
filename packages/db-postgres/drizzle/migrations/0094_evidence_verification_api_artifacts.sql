ALTER TABLE "evidence_verification_artifacts"
  DROP CONSTRAINT IF EXISTS "evidence_verification_artifacts_content_type_check";
--> statement-breakpoint
ALTER TABLE "evidence_verification_artifacts"
  ADD CONSTRAINT "evidence_verification_artifacts_content_type_check"
  CHECK ("content_type" IN ('image/png', 'image/jpeg', 'application/json'));
