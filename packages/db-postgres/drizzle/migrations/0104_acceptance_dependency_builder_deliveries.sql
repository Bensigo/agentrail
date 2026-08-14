-- Reserve-before-send custody for one initial github_claude dependency Pack.
-- This lifecycle is intentionally separate from correction dispatch.
CREATE TABLE IF NOT EXISTS "acceptance_dependency_builder_deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "external_builder_pack_id" uuid NOT NULL,
  "external_builder_pack_event_id" uuid NOT NULL,
  "external_builder_pack_identity_sha256" text NOT NULL,
  "observation_event_id" uuid NOT NULL,
  "approval_event_id" uuid NOT NULL,
  "candidate_fingerprint" text NOT NULL,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "delivered_head_sha" text NOT NULL,
  "delivered_head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "acceptance_contract_sha256" text NOT NULL,
  "compiled_pack_id" uuid NOT NULL REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "compiled_pack_sha256" text NOT NULL,
  "source_custody_identity_sha256" text NOT NULL,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "route_adapter" text NOT NULL,
  "route_configuration_version" integer NOT NULL,
  "route_selection_event_id" uuid NOT NULL,
  "route_snapshot_sha256" text NOT NULL,
  "capability_snapshot" jsonb NOT NULL,
  "capability_snapshot_sha256" text NOT NULL,
  "github_installation_identity_sha256" text NOT NULL,
  "requested_by" text NOT NULL,
  "requested_role" text NOT NULL,
  "delivery_identity_sha256" text NOT NULL,
  "body" text NOT NULL,
  "body_sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "github_comment_id" text,
  "github_comment_url" text,
  "result_reason" text,
  "github_delivery_id" text,
  "github_delivery_event_id" uuid,
  "github_head_advance_event_id" uuid,
  "successor_head_sha" text,
  "successor_head_cycle_id" uuid,
  "successor_review_job_id" uuid REFERENCES "review_jobs"("id") ON DELETE restrict,
  "reentered_at" timestamp with time zone,
  "reserved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_dependency_builder_deliveries_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 512
    AND btrim("repo") = "repo"
    AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
    AND "pr_number" > 0
    AND "delivered_head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "route_adapter" = 'github_claude'
    AND "route_configuration_version" > 0
    AND "candidate_fingerprint" ~ '^sha256:[A-Fa-f0-9]{64}$'
    AND "external_builder_pack_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "acceptance_contract_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "compiled_pack_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "source_custody_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "route_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND jsonb_typeof("capability_snapshot") = 'object'
    AND "capability_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "github_installation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "requested_by" ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "requested_role" IN ('owner', 'admin')
    AND "delivery_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND octet_length("body") BETWEEN 1 AND 12288
    AND "body_sha256" ~ '^[A-Fa-f0-9]{64}$'
  ),
  CONSTRAINT "acceptance_dependency_builder_deliveries_state_check" CHECK (
    "status" IN ('reserved', 'carrier_accepted', 'bounded_failed', 'ambiguous_hold', 'reentered')
    AND (("status" = 'reserved') = ("completed_at" IS NULL))
    AND (("status" IN ('carrier_accepted', 'reentered')) = ("github_comment_id" IS NOT NULL))
    AND (("status" IN ('carrier_accepted', 'reentered')) = ("github_comment_url" IS NOT NULL))
    AND ("github_comment_id" IS NULL OR (char_length("github_comment_id") BETWEEN 1 AND 40 AND "github_comment_id" ~ '^[1-9][0-9]*$'))
    AND ("github_comment_url" IS NULL OR "github_comment_url" = 'https://github.com/' || "repo" || '/pull/' || ("pr_number")::text || '#issuecomment-' || "github_comment_id")
    AND (("status" IN ('bounded_failed', 'ambiguous_hold')) = ("result_reason" IS NOT NULL))
    AND ("status" <> 'bounded_failed' OR "result_reason" IN ('credential_unavailable', 'github_rejected', 'invalid_db_issued_body'))
    AND ("status" <> 'ambiguous_hold' OR "result_reason" IN ('github_unavailable', 'ambiguous_response', 'storage_unavailable'))
    AND (("status" = 'reentered') = ("reentered_at" IS NOT NULL))
    AND (("status" = 'reentered') = ("successor_head_sha" IS NOT NULL))
    AND (("status" = 'reentered') = ("successor_head_cycle_id" IS NOT NULL))
    AND (("status" = 'reentered') = ("successor_review_job_id" IS NOT NULL))
    AND (("status" = 'reentered') = ("github_delivery_id" IS NOT NULL))
    AND (("status" = 'reentered') = ("github_delivery_event_id" IS NOT NULL))
    AND (("status" = 'reentered') = ("github_head_advance_event_id" IS NOT NULL))
    AND ("successor_head_sha" IS NULL OR "successor_head_sha" ~ '^[A-Fa-f0-9]{40}$')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_dependency_builder_deliveries_pack_event_key"
  ON "acceptance_dependency_builder_deliveries" ("external_builder_pack_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_dependency_builder_deliveries_comment_key"
  ON "acceptance_dependency_builder_deliveries" ("github_comment_id")
  WHERE "github_comment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_dependency_builder_deliveries_record_head_idx"
  ON "acceptance_dependency_builder_deliveries" ("workspace_id", "record_id", "delivered_head_cycle_id");
