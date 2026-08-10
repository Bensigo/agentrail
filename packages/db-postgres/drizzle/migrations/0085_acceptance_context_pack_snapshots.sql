CREATE TABLE IF NOT EXISTS "acceptance_context_pack_snapshots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "review_job_id" uuid NOT NULL REFERENCES "review_jobs"("id") ON DELETE restrict,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "expected_head_sha" text NOT NULL,
  "base_sha" text,
  "merge_base_sha" text,
  "head_tree_sha" text,
  "packet_ids" jsonb NOT NULL,
  "packet_set_sha256" text NOT NULL,
  "compiler_version" text NOT NULL,
  "base_index" jsonb,
  "overlay" jsonb,
  "provenance" jsonb NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_context_pack_snapshots_status_check"
    CHECK ("status" IN ('admitted', 'not_proven')),
  CONSTRAINT "acceptance_context_pack_snapshots_repo_check"
    CHECK (char_length("repo") BETWEEN 3 AND 512 AND btrim("repo") = "repo" AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' AND split_part("repo", '/', 1) NOT IN ('.', '..') AND split_part("repo", '/', 2) NOT IN ('.', '..')),
  CONSTRAINT "acceptance_context_pack_snapshots_expected_head_sha_check"
    CHECK ("expected_head_sha" ~ '^[A-Fa-f0-9]{40}$'),
  CONSTRAINT "acceptance_context_pack_snapshots_pr_number_check"
    CHECK ("pr_number" > 0),
  CONSTRAINT "acceptance_context_pack_snapshots_packet_set_sha256_check"
    CHECK ("packet_set_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_context_pack_snapshots_compiler_version_check"
    CHECK (char_length("compiler_version") BETWEEN 1 AND 128 AND btrim("compiler_version") = "compiler_version" AND "compiler_version" !~ '[[:cntrl:]]'),
  CONSTRAINT "acceptance_context_pack_snapshots_identity_json_check"
    CHECK (jsonb_typeof("packet_ids") = 'array' AND ("base_index" IS NULL OR jsonb_typeof("base_index") = 'object') AND ("overlay" IS NULL OR jsonb_typeof("overlay") = 'object') AND jsonb_typeof("provenance") = 'object'),
  CONSTRAINT "acceptance_context_pack_snapshots_reason_check"
    CHECK ("reason" IS NULL OR (char_length("reason") BETWEEN 1 AND 2000 AND btrim("reason") = "reason" AND "reason" !~ '[[:cntrl:]]')),
  CONSTRAINT "acceptance_context_pack_snapshots_source_state_check"
    CHECK (("status" = 'admitted' AND "base_sha" ~ '^[A-Fa-f0-9]{40}$' AND "merge_base_sha" ~ '^[A-Fa-f0-9]{40}$' AND "head_tree_sha" ~ '^[A-Fa-f0-9]{40}$' AND "base_index" IS NOT NULL AND "overlay" IS NOT NULL AND "reason" IS NULL)
      OR ("status" = 'not_proven' AND "base_sha" IS NULL AND "merge_base_sha" IS NULL AND "head_tree_sha" IS NULL AND "base_index" IS NULL AND "overlay" IS NULL AND "reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_snapshots_replay_key"
  ON "acceptance_context_pack_snapshots" ("review_job_id", "compiler_version", "packet_set_sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_snapshots_review_job_idx"
  ON "acceptance_context_pack_snapshots" ("review_job_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_snapshots_record_idx"
  ON "acceptance_context_pack_snapshots" ("record_id", "created_at");
