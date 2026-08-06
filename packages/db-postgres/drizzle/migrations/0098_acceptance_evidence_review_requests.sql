CREATE TABLE IF NOT EXISTS "acceptance_evidence_review_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "pr_revision_id" uuid NOT NULL REFERENCES "change_record_pr_revisions"("id") ON DELETE restrict,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "head_sha" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "reason" text,
  "requested_by" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_evidence_review_requests_status_check"
    CHECK ("status" IN ('queued', 'completed', 'failed', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_evidence_review_requests_revision_key"
  ON "acceptance_evidence_review_requests" ("pr_revision_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_evidence_review_requests_queued_idx"
  ON "acceptance_evidence_review_requests" ("requested_at") WHERE "status" = 'queued';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_evidence_review_requests_record_idx"
  ON "acceptance_evidence_review_requests" ("record_id", "requested_at");
