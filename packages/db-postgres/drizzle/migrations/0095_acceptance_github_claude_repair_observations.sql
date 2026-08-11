-- One immutable, repair-specific GitHub Actions OIDC observation for the
-- already acknowledged selected Claude run. This is not an authorship claim:
-- canonical repair-head evidence remains a derived join with GitHub's signed
-- synchronize custody and the exact successor review cycle.
CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatch_github_claude_repair_obs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "dispatch_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatches"("id") ON DELETE restrict,
  "activation_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatch_github_activations"("id") ON DELETE restrict,
  "acknowledgement_receipt_id" uuid NOT NULL REFERENCES "acceptance_correction_dispatch_github_claude_ack_receipts"("id") ON DELETE restrict,
  "acknowledgement_receipt_identity_sha256" text NOT NULL,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "original_head_sha" text NOT NULL,
  "original_head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "dispatch_identity_sha256" text NOT NULL,
  "activation_identity_sha256" text NOT NULL,
  "activation_github_comment_id" text NOT NULL,
  "activation_body_sha256" text NOT NULL,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "route_configuration_version" integer NOT NULL,
  "capability_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_capability_profiles"("id") ON DELETE restrict,
  "acknowledgement_profile_id" uuid NOT NULL REFERENCES "acceptance_builder_route_github_claude_ack_profiles"("id") ON DELETE restrict,
  "acknowledgement_profile_snapshot_sha256" text NOT NULL,
  "observation_protocol_version" integer NOT NULL DEFAULT 1,
  "provider" text NOT NULL,
  "provider_session_id_sha256" text NOT NULL,
  "before_head_sha" text NOT NULL,
  "after_head_sha" text NOT NULL,
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
  "observation_identity_sha256" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_claude_repair_observations_binding_check" CHECK (
    char_length("repo") BETWEEN 3 AND 512
    AND btrim("repo") = "repo"
    AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
    AND "pr_number" > 0
    AND "original_head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND "before_head_sha" = "original_head_sha"
    AND "after_head_sha" ~ '^[A-Fa-f0-9]{40}$'
    AND lower("after_head_sha") <> lower("before_head_sha")
    AND "authority_generation" >= 0
    AND "dispatch_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "activation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "activation_github_comment_id" ~ '^[1-9][0-9]{0,39}$'
    AND "activation_body_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "acknowledgement_receipt_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "route_configuration_version" > 0
    AND "acknowledgement_profile_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "observation_protocol_version" = 1
    AND "provider" = 'anthropic_claude_code_action'
    AND "provider_session_id_sha256" ~ '^[A-Fa-f0-9]{64}$'
    AND "oidc_issuer" = 'https://token.actions.githubusercontent.com'
    AND "oidc_audience" ~ '^agentrail://correction-dispatch/github-claude/repair-observation/v1/[A-Fa-f0-9]{64}$'
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
    AND "observation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_repair_observations_dispatch_key"
  ON "acceptance_correction_dispatch_github_claude_repair_obs" ("dispatch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_repair_observations_activation_key"
  ON "acceptance_correction_dispatch_github_claude_repair_obs" ("activation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_repair_observations_ack_key"
  ON "acceptance_correction_dispatch_github_claude_repair_obs" ("acknowledgement_receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_claude_repair_observations_oidc_jti_key"
  ON "acceptance_correction_dispatch_github_claude_repair_obs" ("oidc_jti_sha256");
