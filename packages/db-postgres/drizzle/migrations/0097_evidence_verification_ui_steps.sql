ALTER TABLE "evidence_verification_plans" ADD COLUMN "ui_steps" jsonb;
--> statement-breakpoint
ALTER TABLE "evidence_verification_plans" ADD CONSTRAINT "evidence_verification_plans_ui_steps_check" CHECK (("evidence_verification_plans"."modality" <> 'ui') OR ("evidence_verification_plans"."status" <> 'planned') OR ("evidence_verification_plans"."ui_steps" IS NOT NULL AND jsonb_typeof("evidence_verification_plans"."ui_steps") = 'array' AND jsonb_array_length("evidence_verification_plans"."ui_steps") BETWEEN 1 AND 12)) NOT VALID;
