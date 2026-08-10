CREATE TABLE IF NOT EXISTS "acceptance_builder_routes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "repo" text NOT NULL,
  "adapter" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "configuration_version" integer NOT NULL,
  "registered_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_builder_routes_adapter_check"
    CHECK ("adapter" IN ('github_codex', 'github_claude', 'durable_github_fallback', 'durable_jace_fallback')),
  CONSTRAINT "acceptance_builder_routes_status_check"
    CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "acceptance_builder_routes_configuration_version_check"
    CHECK ("configuration_version" > 0),
  CONSTRAINT "acceptance_builder_routes_repo_check"
    CHECK (char_length("repo") BETWEEN 1 AND 512 AND btrim("repo") = "repo" AND "repo" !~ '[[:cntrl:]]'),
  CONSTRAINT "acceptance_builder_routes_registered_by_check"
    CHECK (
      char_length("registered_by") BETWEEN 6 AND 256
      AND "registered_by" ~ '^(user|server):[A-Za-z0-9][A-Za-z0-9._@+-]*$'
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_builder_routes_workspace_repo_status_idx"
  ON "acceptance_builder_routes" ("workspace_id", "repo", "status");
