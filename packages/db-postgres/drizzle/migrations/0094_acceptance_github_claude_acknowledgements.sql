-- One verifiable github_claude acknowledgement lane. The route profile pins
-- the trusted GitHub Actions and Anthropic Action identities; the receipt
-- records only normalized OIDC metadata and hashes of opaque session/token
-- locators. It does not claim repair, a new head, or provider parity.
CREATE TABLE IF NOT EXISTS "acceptance_builder_route_github_claude_ack_profiles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "capability_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_capability_profiles"("id") ON DELETE restrict,
  "capability_profile_snapshot_sha256" text NOT NULL,
  "repo" text NOT NULL,
  "route_configuration_version" integer NOT NULL,
  "github_repository_id" text NOT NULL,
  "github_repository_owner_id" text NOT NULL,
  "github_app_bot_user_id" text NOT NULL,
  "github_app_bot_login" text NOT NULL,
  "oidc_issuer" text NOT NULL,
  "oidc_audience_contract" text NOT NULL,
  "oidc_subject_contract" text NOT NULL,
  "caller_workflow_ref" text NOT NULL,
  "job_workflow_ref" text NOT NULL,
  "job_workflow_sha" text NOT NULL,
  "claude_action_sha" text NOT NULL,
  "workflow_contract" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "snapshot_sha256" text NOT NULL,
  "recorded_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_builder_claude_ack_profiles_binding_check" CHECK (
    "route_configuration_version" > 0
    AND char_length("repo") BETWEEN 3 AND 512
    AND btrim("repo") = "repo"
    AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
    AND "capability_profile_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "github_repository_id" ~ '^[1-9][0-9]{0,39}$'
    AND "github_repository_owner_id" ~ '^[1-9][0-9]{0,39}$'
    AND "github_app_bot_user_id" ~ '^[1-9][0-9]{0,39}$'
    AND "github_app_bot_login" = 'jace[bot]'
    AND "oidc_issuer" = 'https://token.actions.githubusercontent.com'
    AND "oidc_audience_contract" = 'activation_comment_run_attempt_sha256_v1'
    AND "oidc_subject_contract" = 'default_repo_ref_legacy_or_immutable_v1'
    AND char_length("caller_workflow_ref") BETWEEN 1 AND 1024
    AND "caller_workflow_ref" LIKE "repo" || '/.github/workflows/%@refs/heads/%'
    AND "caller_workflow_ref" !~ '[[:cntrl:]]'
    AND char_length("job_workflow_ref") BETWEEN 1 AND 1024
    AND "job_workflow_ref" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/\.github/workflows/[A-Za-z0-9._/-]+\.ya?ml@[A-Fa-f0-9]{40}$'
    AND right(lower("job_workflow_ref"), 40) = lower("job_workflow_sha")
    AND "job_workflow_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "claude_action_sha" = '6b082c41935b4c8a3b8b0ef85ba4ba4d9eeb8975'
    AND "workflow_contract" = 'github_claude_action_success_session_v1'
    AND jsonb_typeof("snapshot") = 'object'
    AND "snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
  ),
  CONSTRAINT "acceptance_builder_claude_ack_profiles_recorded_by_check" CHECK (
    char_length("recorded_by") BETWEEN 8 AND 256
    AND "recorded_by" ~ '^server:[A-Za-z0-9][A-Za-z0-9._@+-]*$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_builder_claude_ack_profiles_route_config_key"
  ON "acceptance_builder_route_github_claude_ack_profiles" ("route_id", "route_configuration_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_builder_claude_ack_profiles_workspace_repo_idx"
  ON "acceptance_builder_route_github_claude_ack_profiles" ("workspace_id", "repo", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_claude_ack_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "dispatch_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatches"("id") ON DELETE restrict,
  "activation_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatch_github_activations"("id") ON DELETE restrict,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "dispatch_identity_sha256" text NOT NULL,
  "activation_identity_sha256" text NOT NULL,
  "activation_github_comment_id" text NOT NULL,
  "activation_body_sha256" text NOT NULL,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "route_configuration_version" integer NOT NULL,
  "capability_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_capability_profiles"("id") ON DELETE restrict,
  "ack_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_github_claude_ack_profiles"("id") ON DELETE restrict,
  "ack_profile_snapshot_sha256" text NOT NULL,
  "acknowledgement_protocol_version" integer NOT NULL DEFAULT 1,
  "provider" text NOT NULL,
  "provider_conclusion" text NOT NULL,
  "provider_session_id_sha256" text NOT NULL,
  "oidc_issuer" text NOT NULL,
  "oidc_audience" text NOT NULL,
  "oidc_subject_sha256" text NOT NULL,
  "oidc_repository" text NOT NULL,
  "oidc_repository_id" text NOT NULL,
  "oidc_repository_owner" text NOT NULL,
  "oidc_repository_owner_id" text NOT NULL,
  "oidc_actor_id" text NOT NULL,
  "oidc_actor" text NOT NULL,
  "oidc_event_name" text NOT NULL,
  "oidc_ref" text NOT NULL,
  "oidc_workflow_ref" text NOT NULL,
  "oidc_workflow_sha" text NOT NULL,
  "oidc_job_workflow_ref" text NOT NULL,
  "oidc_job_workflow_sha" text NOT NULL,
  "oidc_run_id" text NOT NULL,
  "oidc_run_attempt" integer NOT NULL,
  "oidc_check_run_id" text NOT NULL,
  "oidc_token_issued_at" timestamp with time zone NOT NULL,
  "oidc_token_not_before" timestamp with time zone NOT NULL,
  "oidc_token_expires_at" timestamp with time zone NOT NULL,
  "oidc_jti_sha256" text NOT NULL,
  "receipt_identity_sha256" text NOT NULL,
  "acknowledged_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_claude_ack_receipts_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 512
    AND btrim("repo") = "repo"
    AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
    AND "pr_number" > 0
    AND "head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "dispatch_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "activation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "activation_github_comment_id" ~ '^[1-9][0-9]{0,39}$'
    AND "activation_body_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "route_configuration_version" > 0
    AND "ack_profile_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "acknowledgement_protocol_version" = 1
    AND "provider" = 'anthropic_claude_code_action'
    AND "provider_conclusion" = 'success'
    AND "provider_session_id_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "oidc_issuer" = 'https://token.actions.githubusercontent.com'
    AND "oidc_audience" ~ '^agentrail://correction-dispatch/github-claude/ack/v1/[A-Fa-f0-9]{64}$'
    AND "oidc_subject_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "oidc_repository" = "repo"
    AND "oidc_repository_id" ~ '^[1-9][0-9]{0,39}$'
    AND char_length("oidc_repository_owner") BETWEEN 1 AND 100
    AND "oidc_repository_owner" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,99}$'
    AND "oidc_repository_owner_id" ~ '^[1-9][0-9]{0,39}$'
    AND "oidc_actor_id" ~ '^[1-9][0-9]{0,39}$'
    AND "oidc_actor" = 'jace[bot]'
    AND "oidc_event_name" = 'issue_comment'
    AND char_length("oidc_ref") BETWEEN 12 AND 512
    AND "oidc_ref" LIKE 'refs/heads/%'
    AND "oidc_ref" !~ '[[:cntrl:]]'
    AND char_length("oidc_workflow_ref") BETWEEN 1 AND 1024
    AND "oidc_workflow_ref" !~ '[[:cntrl:]]'
    AND "oidc_workflow_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND char_length("oidc_job_workflow_ref") BETWEEN 1 AND 1024
    AND "oidc_job_workflow_ref" !~ '[[:cntrl:]]'
    AND "oidc_job_workflow_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "oidc_run_id" ~ '^[1-9][0-9]{0,39}$'
    AND "oidc_run_attempt" = 1
    AND "oidc_check_run_id" ~ '^[1-9][0-9]{0,39}$'
    AND "oidc_token_not_before" <= "oidc_token_expires_at"
    AND "oidc_token_issued_at" <= "oidc_token_expires_at"
    AND "oidc_jti_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "receipt_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_ack_receipts_dispatch_key"
  ON "acceptance_correction_dispatch_github_claude_ack_receipts" ("dispatch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_ack_receipts_activation_key"
  ON "acceptance_correction_dispatch_github_claude_ack_receipts" ("activation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_ack_receipts_oidc_jti_key"
  ON "acceptance_correction_dispatch_github_claude_ack_receipts" ("oidc_jti_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_ack_receipts_oidc_run_key"
  ON "acceptance_correction_dispatch_github_claude_ack_receipts" ("oidc_repository_id", "oidc_run_id");
