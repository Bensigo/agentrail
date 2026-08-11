-- Additive Jace approval custody for #1704's exact packet-bound issue draft.
-- Historical protocol-v1 publication rows remain readable. New protocol-v2
-- writes must originate from an Eve-bound opaque request and approved
-- create_issue row, and repository/receipt uniqueness is case-normalized.
CREATE TABLE IF NOT EXISTS "acceptance_gated_github_issue_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "jace_session_id" uuid NOT NULL REFERENCES "jace_sessions"("id") ON DELETE restrict,
  "eve_session_id" text NOT NULL,
  "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "requested_role" text NOT NULL,
  "repo" text NOT NULL,
  "repo_normalized" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "review_job_id" uuid NOT NULL REFERENCES "review_jobs"("id") ON DELETE restrict,
  "binding_id" uuid NOT NULL,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "acceptance_contract_sha256" text NOT NULL,
  "criterion_outcome_bundle_id" uuid NOT NULL,
  "criterion_outcome_bundle_event_id" uuid NOT NULL,
  "criterion_outcome_bundle_sha256" text NOT NULL,
  "posted_attestation_event_id" uuid NOT NULL,
  "packets" jsonb NOT NULL,
  "packet_set_sha256" text NOT NULL,
  "correction_packet_payload_set_sha256" text NOT NULL,
  "request_identity_sha256" text NOT NULL,
  "title" text NOT NULL,
  "title_sha256" text NOT NULL,
  "body" text NOT NULL,
  "body_sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "approval_id" uuid REFERENCES "jace_approvals"("id") ON DELETE restrict,
  "published_issue_url" text,
  "observed_issue_url" text,
  "reconciliation_reason" text,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reserved_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "reconciliation_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_gated_github_issue_requests_binding_check" CHECK (
    octet_length("eve_session_id") BETWEEN 1 AND 512
    AND "requested_role" IN ('owner', 'admin')
    AND char_length("repo") BETWEEN 3 AND 201
    AND btrim("repo") = "repo"
    AND "repo_normalized" = lower("repo")
    AND "repo_normalized" ~ '^[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}$'
    AND "repo" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    AND split_part("repo", '/', 1) NOT IN ('.', '..')
    AND split_part("repo", '/', 2) NOT IN ('.', '..')
    AND "pr_number" > 0
    AND "head_sha" ~ '^[a-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "acceptance_contract_sha256" ~ '^[a-f0-9]{64}$'
    AND "criterion_outcome_bundle_sha256" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("packets") = 'array'
    AND jsonb_array_length("packets") BETWEEN 1 AND 100
    AND "packet_set_sha256" ~ '^[a-f0-9]{64}$'
    AND "correction_packet_payload_set_sha256" ~ '^[a-f0-9]{64}$'
    AND "request_identity_sha256" ~ '^[a-f0-9]{64}$'
    AND octet_length("title") BETWEEN 1 AND 256
    AND octet_length("body") BETWEEN 1 AND 24576
    AND "title_sha256" ~ '^[a-f0-9]{64}$'
    AND "body_sha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "acceptance_gated_github_issue_requests_state_check" CHECK (
    "status" IN ('draft', 'reserved', 'published', 'manual_reconciliation')
    AND ("status" = 'draft') = ("approval_id" IS NULL)
    AND ("status" = 'draft') = ("reserved_at" IS NULL)
    AND ("status" = 'published') = ("published_issue_url" IS NOT NULL)
    AND ("status" = 'published') = ("published_at" IS NOT NULL)
    AND ("status" = 'manual_reconciliation') = ("reconciliation_reason" IS NOT NULL)
    AND ("status" = 'manual_reconciliation') = ("reconciliation_at" IS NOT NULL)
    AND ("status" <> 'published' OR (
      "published_issue_url" ~ '^https://github\.com/[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}/issues/[1-9][0-9]*$'
      AND split_part("published_issue_url", '/issues/', 1) = ('https://github.com/' || "repo_normalized")
    ))
    AND ("observed_issue_url" IS NULL OR ("status" = 'manual_reconciliation'
      AND "observed_issue_url" ~ '^https://github\.com/[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}/issues/[1-9][0-9]*$'))
    AND ("status" <> 'manual_reconciliation' OR "reconciliation_reason" IN (
      'external_write_indeterminate', 'publication_receipt_failed', 'external_issue_wrong_repo'
    ))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issue_requests_record_cycle_key"
  ON "acceptance_gated_github_issue_requests" ("record_id", "head_cycle_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issue_requests_approval_key"
  ON "acceptance_gated_github_issue_requests" ("approval_id") WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issue_requests_url_key"
  ON "acceptance_gated_github_issue_requests" (lower("published_issue_url"))
  WHERE "published_issue_url" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "acceptance_gated_github_issue_publications"
  ADD COLUMN IF NOT EXISTS "repo_normalized" text;
--> statement-breakpoint
UPDATE "acceptance_gated_github_issue_publications"
SET "repo_normalized" = lower("repo")
WHERE "repo_normalized" IS NULL;
--> statement-breakpoint
ALTER TABLE "acceptance_gated_github_issue_publications"
  ALTER COLUMN "repo_normalized" SET NOT NULL,
  ADD COLUMN IF NOT EXISTS "approval_request_id" uuid REFERENCES "acceptance_gated_github_issue_requests"("id") ON DELETE restrict,
  ADD COLUMN IF NOT EXISTS "approval_id" uuid REFERENCES "jace_approvals"("id") ON DELETE restrict,
  ADD COLUMN IF NOT EXISTS "eve_session_id" text,
  ADD COLUMN IF NOT EXISTS "observed_issue_url" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "acceptance_gated_github_issues_repo_number_key";
--> statement-breakpoint
ALTER TABLE "acceptance_gated_github_issue_publications"
  DROP CONSTRAINT IF EXISTS "acceptance_gated_github_issues_binding_check",
  DROP CONSTRAINT IF EXISTS "acceptance_gated_github_issues_state_check";
--> statement-breakpoint
ALTER TABLE "acceptance_gated_github_issue_publications"
  ADD CONSTRAINT "acceptance_gated_github_issues_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 201
    AND btrim("repo") = "repo"
    AND "repo_normalized" = lower("repo")
    AND "repo_normalized" ~ '^[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}$'
    AND "repo" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    AND split_part("repo", '/', 1) NOT IN ('.', '..')
    AND split_part("repo", '/', 2) NOT IN ('.', '..')
    AND "pr_number" > 0
    AND "head_sha" ~ '^[a-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "acceptance_contract_sha256" ~ '^[a-f0-9]{64}$'
    AND "criterion_outcome_bundle_sha256" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("packets") = 'array'
    AND jsonb_array_length("packets") BETWEEN 1 AND 100
    AND "packet_set_sha256" ~ '^[a-f0-9]{64}$'
    AND "correction_packet_payload_set_sha256" ~ '^[a-f0-9]{64}$'
    AND "request_protocol_version" IN (1, 2)
    AND (("request_protocol_version" = 1 AND "approval_request_id" IS NULL
      AND "approval_id" IS NULL AND "eve_session_id" IS NULL)
      OR ("request_protocol_version" = 2 AND "approval_request_id" IS NOT NULL
        AND "approval_id" IS NOT NULL AND octet_length("eve_session_id") BETWEEN 1 AND 512))
    AND "request_identity_sha256" ~ '^[a-f0-9]{64}$'
    AND octet_length("title") BETWEEN 1 AND 256
    AND octet_length("body") BETWEEN 1 AND 24576
    AND "title_sha256" ~ '^[a-f0-9]{64}$'
    AND "body_sha256" ~ '^[a-f0-9]{64}$'
    AND "reserved_by" ~ '^user:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    AND "reserved_role" IN ('owner', 'admin')
  ),
  ADD CONSTRAINT "acceptance_gated_github_issues_state_check" CHECK (
    "status" IN ('reserved', 'published', 'bounded_failed', 'ambiguous_hold')
    AND (("status" = 'reserved') = ("completed_at" IS NULL))
    AND ("status" <> 'published' OR (
      "http_status" = 201
      AND "github_issue_id" ~ '^[1-9][0-9]{0,39}$'
      AND "github_issue_number" > 0
      AND "github_api_url" = 'https://api.github.com/repos/' || CASE WHEN "request_protocol_version" = 2 THEN "repo_normalized" ELSE "repo" END || '/issues/' || ("github_issue_number")::text
      AND "github_issue_url" = 'https://github.com/' || CASE WHEN "request_protocol_version" = 2 THEN "repo_normalized" ELSE "repo" END || '/issues/' || ("github_issue_number")::text
      AND char_length("github_request_id") BETWEEN 1 AND 128
      AND "github_request_id" ~ '^[A-Za-z0-9:-]+$'
      AND "response_title_sha256" = "title_sha256"
      AND "response_body_sha256" = "body_sha256"
      AND "github_state" = 'open'
      AND "result_reason" IS NULL
    ))
    AND ("status" <> 'bounded_failed' OR "result_reason" IN (
      'github_rejected', 'invalid_db_issued_request'
    ))
    AND ("status" <> 'ambiguous_hold' OR "result_reason" IN (
      'github_unavailable', 'ambiguous_response', 'external_write_indeterminate',
      'publication_receipt_failed', 'external_issue_wrong_repo'
    ))
    AND ("observed_issue_url" IS NULL OR ("status" = 'ambiguous_hold'
      AND "observed_issue_url" ~ '^https://github\.com/[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}/issues/[1-9][0-9]*$'))
    AND (("status" IN ('bounded_failed', 'ambiguous_hold')) = ("result_reason" IS NOT NULL))
    AND ("status" <> 'reserved' OR (
      "http_status" IS NULL AND "github_issue_id" IS NULL AND "github_issue_number" IS NULL
      AND "github_api_url" IS NULL AND "github_issue_url" IS NULL AND "github_request_id" IS NULL
      AND "response_title_sha256" IS NULL AND "response_body_sha256" IS NULL
      AND "github_state" IS NULL AND "result_reason" IS NULL
    ))
    AND ("status" IN ('reserved', 'published') OR (
      "http_status" IS NULL AND "github_issue_id" IS NULL AND "github_issue_number" IS NULL
      AND "github_api_url" IS NULL AND "github_issue_url" IS NULL AND "github_request_id" IS NULL
      AND "response_title_sha256" IS NULL AND "response_body_sha256" IS NULL
      AND "github_state" IS NULL
    ))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issues_repo_number_key"
  ON "acceptance_gated_github_issue_publications" ("repo_normalized", "github_issue_number")
  WHERE "github_issue_number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issues_request_key"
  ON "acceptance_gated_github_issue_publications" ("approval_request_id")
  WHERE "approval_request_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issues_approval_key"
  ON "acceptance_gated_github_issue_publications" ("approval_id")
  WHERE "approval_id" IS NOT NULL;
