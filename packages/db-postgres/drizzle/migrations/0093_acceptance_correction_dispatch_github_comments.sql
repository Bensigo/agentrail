-- Immutable two-stage GitHub carrier custody. Finding rows are inert ordinary
-- PR issue comments; only the singleton activation may contain one selected
-- vendor mention. These tables store no credential, raw response, or agent
-- acknowledgement/repair claim.
CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_finding_publications" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "dispatch_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatches"("id") ON DELETE restrict,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "packet_id" text NOT NULL,
  "criterion_id" text NOT NULL,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "base_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "dispatch_identity_sha256" text NOT NULL,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "route_adapter" text NOT NULL,
  "route_configuration_version" integer NOT NULL,
  "capability_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_capability_profiles"("id") ON DELETE restrict,
  "capability_profile_snapshot_sha256" text NOT NULL,
  "github_installation_identity_sha256" text NOT NULL,
  "ready_preflight_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatch_github_preflights"("id") ON DELETE restrict,
  "ready_preflight_identity_sha256" text NOT NULL,
  "publication_protocol_version" integer NOT NULL DEFAULT 1,
  "publication_identity_sha256" text NOT NULL,
  "carrier" text NOT NULL DEFAULT 'github_issue_comment',
  "packet_payload_sha256" text NOT NULL,
  "body" text,
  "body_sha256" text,
  "status" text NOT NULL DEFAULT 'reserved',
  "github_comment_id" text,
  "github_comment_url" text,
  "result_reason" text,
  "reserved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_correction_gh_findings_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 512
    AND btrim("repo") = "repo"
    AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
    AND split_part("repo", '/', 1) NOT IN ('.', '..')
    AND split_part("repo", '/', 2) NOT IN ('.', '..')
    AND "pr_number" > 0
    AND "head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "base_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "dispatch_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "packet_id" ~ '^correction-[A-Fa-f0-9]{48}$'
    AND char_length("criterion_id") BETWEEN 1 AND 512
    AND btrim("criterion_id") = "criterion_id"
    AND "criterion_id" !~ '[[:cntrl:]]'
    AND "route_adapter" IN ('github_codex', 'github_claude')
    AND "route_configuration_version" > 0
    AND "capability_profile_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "github_installation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "ready_preflight_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "publication_protocol_version" = 1
    AND "publication_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "carrier" = 'github_issue_comment'
    AND "packet_payload_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND ("body" IS NULL OR octet_length("body") BETWEEN 1 AND 12288)
    AND ("body_sha256" IS NULL OR "body_sha256" ~ '^[A-Fa-f0-9]{64}$')
  ),
  CONSTRAINT "acceptance_correction_gh_findings_state_check" CHECK (
    "status" IN ('reserved', 'published', 'bounded_failed', 'ambiguous_hold')
    AND (("status" = 'reserved') = ("completed_at" IS NULL))
    AND (("status" = 'published') = ("github_comment_id" IS NOT NULL))
    AND (("status" = 'published') = ("github_comment_url" IS NOT NULL))
    AND ("github_comment_id" IS NULL OR (char_length("github_comment_id") BETWEEN 1 AND 40 AND "github_comment_id" ~ '^[1-9][0-9]*$'))
    AND ("github_comment_url" IS NULL OR "github_comment_url" = 'https://github.com/' || "repo" || '/pull/' || ("pr_number")::text || '#issuecomment-' || "github_comment_id")
    AND (("status" IN ('bounded_failed', 'ambiguous_hold')) = ("result_reason" IS NOT NULL))
    AND ("status" <> 'bounded_failed' OR "result_reason" IN ('github_rejected', 'invalid_db_issued_body'))
    AND ("status" <> 'ambiguous_hold' OR "result_reason" IN ('github_unavailable', 'ambiguous_response'))
    AND ("body" IS NOT NULL OR ("status" = 'bounded_failed' AND "result_reason" = 'invalid_db_issued_body'))
    AND (("body" IS NULL) = ("body_sha256" IS NULL))
    AND ("status" <> 'reserved' OR ("github_comment_id" IS NULL AND "github_comment_url" IS NULL AND "result_reason" IS NULL))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_correction_gh_findings_dispatch_packet_key"
  ON "acceptance_correction_dispatch_github_finding_publications" ("dispatch_id", "packet_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_correction_gh_findings_comment_receipt_key"
  ON "acceptance_correction_dispatch_github_finding_publications" ("github_comment_id")
  WHERE "github_comment_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_activations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "dispatch_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatches"("id") ON DELETE restrict,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "base_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "dispatch_identity_sha256" text NOT NULL,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "route_adapter" text NOT NULL,
  "route_configuration_version" integer NOT NULL,
  "capability_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_capability_profiles"("id") ON DELETE restrict,
  "capability_profile_snapshot_sha256" text NOT NULL,
  "github_installation_identity_sha256" text NOT NULL,
  "ready_preflight_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatch_github_preflights"("id") ON DELETE restrict,
  "ready_preflight_identity_sha256" text NOT NULL,
  "carrier" text NOT NULL DEFAULT 'github_issue_comment',
  "recipient" text NOT NULL,
  "finding_coverage_sha256" text NOT NULL,
  "packet_set_sha256" text NOT NULL,
  "correction_packet_payload_set_sha256" text NOT NULL,
  "packet_bundle_sha256" text,
  "body" text,
  "body_sha256" text,
  "activation_protocol_version" integer NOT NULL DEFAULT 1,
  "activation_identity_sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "github_comment_id" text,
  "github_comment_url" text,
  "result_reason" text,
  "reserved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_correction_gh_activations_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 512
    AND btrim("repo") = "repo"
    AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
    AND split_part("repo", '/', 1) NOT IN ('.', '..')
    AND split_part("repo", '/', 2) NOT IN ('.', '..')
    AND "pr_number" > 0
    AND "head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "base_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "dispatch_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "route_adapter" IN ('github_codex', 'github_claude')
    AND "route_configuration_version" > 0
    AND "capability_profile_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "github_installation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "ready_preflight_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "carrier" = 'github_issue_comment'
    AND (("route_adapter" = 'github_codex' AND "recipient" = 'codex')
      OR ("route_adapter" = 'github_claude' AND "recipient" = 'claude'))
    AND "finding_coverage_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "packet_set_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "correction_packet_payload_set_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND ("packet_bundle_sha256" IS NULL OR "packet_bundle_sha256" ~ '^[A-Fa-f0-9]{64}$')
    AND ("body" IS NULL OR octet_length("body") BETWEEN 1 AND 61440)
    AND ("body_sha256" IS NULL OR "body_sha256" ~ '^[A-Fa-f0-9]{64}$')
    AND "activation_protocol_version" = 1
    AND "activation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
  ),
  CONSTRAINT "acceptance_correction_gh_activations_state_check" CHECK (
    "status" IN ('reserved', 'carrier_accepted', 'bounded_failed', 'ambiguous_hold')
    AND (("status" = 'reserved') = ("completed_at" IS NULL))
    AND (("status" = 'carrier_accepted') = ("github_comment_id" IS NOT NULL))
    AND (("status" = 'carrier_accepted') = ("github_comment_url" IS NOT NULL))
    AND ("github_comment_id" IS NULL OR (char_length("github_comment_id") BETWEEN 1 AND 40 AND "github_comment_id" ~ '^[1-9][0-9]*$'))
    AND ("github_comment_url" IS NULL OR "github_comment_url" = 'https://github.com/' || "repo" || '/pull/' || ("pr_number")::text || '#issuecomment-' || "github_comment_id")
    AND (("status" IN ('bounded_failed', 'ambiguous_hold')) = ("result_reason" IS NOT NULL))
    AND ("status" <> 'bounded_failed' OR "result_reason" IN ('github_rejected', 'invalid_db_issued_body', 'activation_body_too_large'))
    AND ("status" <> 'ambiguous_hold' OR "result_reason" IN ('github_unavailable', 'ambiguous_response'))
    AND ("body" IS NOT NULL OR ("status" = 'bounded_failed' AND "result_reason" IN ('invalid_db_issued_body', 'activation_body_too_large')))
    AND (("body" IS NULL) = ("body_sha256" IS NULL))
    AND (("packet_bundle_sha256" IS NULL) = ("status" = 'bounded_failed' AND "result_reason" = 'invalid_db_issued_body'))
    AND ("status" <> 'reserved' OR ("github_comment_id" IS NULL AND "github_comment_url" IS NULL AND "result_reason" IS NULL))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_correction_gh_activations_dispatch_key"
  ON "acceptance_correction_dispatch_github_activations" ("dispatch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_correction_gh_activations_comment_receipt_key"
  ON "acceptance_correction_dispatch_github_activations" ("github_comment_id")
  WHERE "github_comment_id" IS NOT NULL;
