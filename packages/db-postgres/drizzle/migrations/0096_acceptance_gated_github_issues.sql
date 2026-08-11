-- One packet-bound, human-gated GitHub issue publication per exact reviewed
-- PR-head occurrence. The database renders the only permitted `{title,body}`
-- request; no labels, credentials, raw packet body, or agent/repair claim is
-- stored. Immutable Change Record events separately retain reservation/result
-- custody while this row supplies one-shot side-effect CAS and receipt keys.
CREATE TABLE IF NOT EXISTS "acceptance_gated_github_issue_publications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "repo" text NOT NULL,
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
  "request_protocol_version" integer NOT NULL DEFAULT 1,
  "request_identity_sha256" text NOT NULL,
  "title" text NOT NULL,
  "title_sha256" text NOT NULL,
  "body" text NOT NULL,
  "body_sha256" text NOT NULL,
  "reserved_by" text NOT NULL,
  "reserved_role" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "http_status" integer,
  "github_issue_id" text,
  "github_issue_number" integer,
  "github_api_url" text,
  "github_issue_url" text,
  "github_request_id" text,
  "response_title_sha256" text,
  "response_body_sha256" text,
  "github_state" text,
  "result_reason" text,
  "reserved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_gated_github_issues_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 201
    AND btrim("repo") = "repo"
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
    AND "request_protocol_version" = 1
    AND "request_identity_sha256" ~ '^[a-f0-9]{64}$'
    AND octet_length("title") BETWEEN 1 AND 256
    AND octet_length("body") BETWEEN 1 AND 24576
    AND "title_sha256" ~ '^[a-f0-9]{64}$'
    AND "body_sha256" ~ '^[a-f0-9]{64}$'
    AND "reserved_by" ~ '^user:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    AND "reserved_role" IN ('owner', 'admin')
  ),
  CONSTRAINT "acceptance_gated_github_issues_state_check" CHECK (
    "status" IN ('reserved', 'published', 'bounded_failed', 'ambiguous_hold')
    AND (("status" = 'reserved') = ("completed_at" IS NULL))
    AND ("status" <> 'published' OR (
      "http_status" = 201
      AND "github_issue_id" ~ '^[1-9][0-9]{0,39}$'
      AND "github_issue_number" > 0
      AND "github_api_url" = 'https://api.github.com/repos/' || "repo" || '/issues/' || ("github_issue_number")::text
      AND "github_issue_url" = 'https://github.com/' || "repo" || '/issues/' || ("github_issue_number")::text
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
      'github_unavailable', 'ambiguous_response'
    ))
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
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issues_record_cycle_key"
  ON "acceptance_gated_github_issue_publications" ("record_id", "head_cycle_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issues_github_id_key"
  ON "acceptance_gated_github_issue_publications" ("github_issue_id")
  WHERE "github_issue_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_gated_github_issues_repo_number_key"
  ON "acceptance_gated_github_issue_publications" ("repo", "github_issue_number")
  WHERE "github_issue_number" IS NOT NULL;
