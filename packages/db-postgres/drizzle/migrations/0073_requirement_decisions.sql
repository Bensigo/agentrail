-- #1583 requirement-level refusal evidence.
-- Keep the existing approval row as the audit record: the human answer,
-- callback/session anchor, refusal contract, and later run outcome remain
-- joinable without introducing a second approval lifecycle.
ALTER TABLE "jace_approvals"
  ADD COLUMN IF NOT EXISTS "requirement_decision" text,
  ADD COLUMN IF NOT EXISTS "requirement_task_family" text,
  ADD COLUMN IF NOT EXISTS "requirement_refusal_code" text,
  ADD COLUMN IF NOT EXISTS "requirement_confidence" jsonb,
  ADD COLUMN IF NOT EXISTS "requirement_status" text,
  ADD COLUMN IF NOT EXISTS "requirement_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "requirement_override_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "jace_approvals_requirement_report_idx"
  ON "jace_approvals" ("workspace_id", "created_at", "requirement_decision");
