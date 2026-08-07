ALTER TABLE "evidence_verification_plans"
  ADD COLUMN IF NOT EXISTS "data_request" jsonb;
--> statement-breakpoint
ALTER TABLE "evidence_verification_plans"
  DROP CONSTRAINT IF EXISTS "evidence_verification_plans_data_request_check";
--> statement-breakpoint
ALTER TABLE "evidence_verification_plans"
  ADD CONSTRAINT "evidence_verification_plans_data_request_check"
  CHECK (
    ("evidence_verification_plans"."modality" <> 'data')
    OR ("evidence_verification_plans"."status" = 'not_testable')
    OR (
      "evidence_verification_plans"."data_request" IS NOT NULL
      AND "evidence_verification_plans"."data_request"->>'method' = 'GET'
      AND length(trim(coalesce("evidence_verification_plans"."data_request"->>'path', ''))) > 0
      AND ("evidence_verification_plans"."data_request"->>'expectedStatus') ~ '^[0-9]{3}$'
      AND jsonb_typeof("evidence_verification_plans"."data_request"->'expectedJson') = 'array'
      AND jsonb_array_length("evidence_verification_plans"."data_request"->'expectedJson') BETWEEN 1 AND 12
    )
  ) NOT VALID;
