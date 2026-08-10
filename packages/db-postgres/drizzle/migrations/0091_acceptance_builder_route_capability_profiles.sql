-- Immutable server-derived configuration for a GitHub-native correction
-- carrier. It is not a vendor availability, acknowledgement, or repair
-- receipt; later carrier execution must establish those facts separately.
CREATE TABLE IF NOT EXISTS "acceptance_builder_route_capability_profiles" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "repo" text NOT NULL,
  "adapter" text NOT NULL,
  "route_configuration_version" integer NOT NULL,
  "github_installation_identity_sha256" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "snapshot_sha256" text NOT NULL,
  "recorded_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_builder_route_cap_profiles_route_config_key"
    UNIQUE ("route_id", "route_configuration_version"),
  CONSTRAINT "acceptance_builder_route_capability_profiles_adapter_check"
    CHECK ("adapter" IN ('github_codex', 'github_claude')),
  CONSTRAINT "acceptance_builder_route_capability_profiles_repo_check"
    CHECK (char_length("repo") BETWEEN 3 AND 512 AND btrim("repo") = "repo" AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'),
  CONSTRAINT "acceptance_builder_route_cap_profiles_config_version_check"
    CHECK ("route_configuration_version" > 0),
  CONSTRAINT "acceptance_builder_route_capability_profiles_snapshot_check"
    CHECK ("github_installation_identity_sha256" ~ '^[A-Fa-f0-9]{64}$' AND jsonb_typeof("snapshot") = 'object' AND "snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_builder_route_capability_profiles_recorded_by_check"
    CHECK (char_length("recorded_by") BETWEEN 8 AND 256 AND "recorded_by" ~ '^server:[A-Za-z0-9][A-Za-z0-9._@+-]*$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_builder_route_capability_profiles_workspace_repo_idx"
  ON "acceptance_builder_route_capability_profiles" ("workspace_id", "repo", "created_at");
--> statement-breakpoint
ALTER TABLE "acceptance_correction_dispatches"
  ADD COLUMN IF NOT EXISTS "capability_profile_id" uuid,
  ADD COLUMN IF NOT EXISTS "capability_profile_snapshot" jsonb,
  ADD COLUMN IF NOT EXISTS "capability_profile_snapshot_sha256" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "acceptance_correction_dispatches"
    ADD CONSTRAINT "acceptance_dispatches_capability_profile_id_fk"
    FOREIGN KEY ("capability_profile_id")
    REFERENCES "acceptance_builder_route_capability_profiles"("id")
    ON DELETE restrict;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "acceptance_correction_dispatches"
    ADD CONSTRAINT "acceptance_correction_dispatches_capability_profile_check"
    CHECK (
      ("capability_profile_id" IS NULL) = ("capability_profile_snapshot" IS NULL)
      AND ("capability_profile_id" IS NULL) = ("capability_profile_snapshot_sha256" IS NULL)
      AND ("capability_profile_snapshot" IS NULL OR jsonb_typeof("capability_profile_snapshot") = 'object')
      AND ("capability_profile_snapshot_sha256" IS NULL OR "capability_profile_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$')
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
