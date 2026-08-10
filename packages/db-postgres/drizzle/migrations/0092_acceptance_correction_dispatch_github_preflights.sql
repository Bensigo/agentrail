-- Immutable-attempt custody for a carrier-inert GitHub-native correction preflight.
-- It records no token, raw installation id, response body, raw error, comment,
-- vendor receipt, or delivery state.
-- A closed result may be `storage_unavailable`: it remains indeterminate so a
-- later reservation creates a bounded successor attempt instead of stranding
-- a reserved row or claiming a GitHub result.
CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_preflights" (
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
  "preflight_protocol_version" integer NOT NULL DEFAULT 1,
  "permission_contract" text NOT NULL,
  "attempt" integer NOT NULL,
  "preflight_identity_sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "result" jsonb,
  "reserved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_correction_github_preflights_dispatch_attempt_key"
    UNIQUE ("dispatch_id", "attempt"),
  CONSTRAINT "acceptance_correction_dispatch_github_preflights_binding_check"
    CHECK (
      btrim("repo") = "repo"
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
      AND "preflight_protocol_version" = 1
      AND "permission_contract" = 'issues_write_and_pull_requests_write_v1'
      AND "attempt" BETWEEN 1 AND 8
      AND "preflight_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    ),
  CONSTRAINT "acceptance_correction_dispatch_github_preflights_status_check"
    CHECK (
      "status" IN ('reserved', 'ready', 'unavailable', 'indeterminate')
      AND (("status" = 'reserved') = ("result" IS NULL))
      AND (("status" = 'reserved') = ("completed_at" IS NULL))
      AND ("result" IS NULL OR jsonb_typeof("result") = 'object')
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_correction_github_preflights_workspace_dispatch_idx"
  ON "acceptance_correction_dispatch_github_preflights" ("workspace_id", "dispatch_id", "created_at");
