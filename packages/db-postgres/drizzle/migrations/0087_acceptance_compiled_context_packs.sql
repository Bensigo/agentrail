-- Immutable, metadata-only compiled Context Packs. Source text and rendered
-- JSON/Markdown remain ephemeral and are intentionally not columns here.
CREATE TABLE IF NOT EXISTS "acceptance_compiled_context_packs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "source_snapshot_id" uuid NOT NULL REFERENCES "acceptance_context_pack_snapshots"("id") ON DELETE restrict,
  "compiler_version" text NOT NULL,
  "policy_version" text NOT NULL,
  "pack_sha256" text NOT NULL,
  "source_custody_identity_sha256" text NOT NULL,
  "json_sha256" text NOT NULL,
  "markdown_sha256" text NOT NULL,
  "rendered_byte_count" integer NOT NULL,
  "binding" jsonb NOT NULL,
  "manifest" jsonb NOT NULL,
  "source_custody_receipt" jsonb NOT NULL,
  "exact_head_dependency_tree_proofs" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_compiled_context_packs_sha_check"
    CHECK ("pack_sha256" ~ '^[A-Fa-f0-9]{64}$'
      AND "source_custody_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'
      AND "json_sha256" ~ '^[A-Fa-f0-9]{64}$'
      AND "markdown_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_compiled_context_packs_version_check"
    CHECK (char_length("compiler_version") BETWEEN 1 AND 128 AND btrim("compiler_version") = "compiler_version" AND "compiler_version" !~ '[[:cntrl:]]'
      AND char_length("policy_version") BETWEEN 1 AND 128 AND btrim("policy_version") = "policy_version" AND "policy_version" !~ '[[:cntrl:]]'),
  CONSTRAINT "acceptance_compiled_context_packs_rendered_byte_count_check"
    CHECK ("rendered_byte_count" > 0 AND "rendered_byte_count" <= 65536),
  CONSTRAINT "acceptance_compiled_context_packs_metadata_check"
    CHECK (jsonb_typeof("binding") = 'object' AND jsonb_typeof("manifest") = 'object' AND jsonb_typeof("source_custody_receipt") = 'object'
      AND jsonb_typeof("exact_head_dependency_tree_proofs") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_compiled_context_packs_replay_key"
  ON "acceptance_compiled_context_packs" ("source_snapshot_id", "compiler_version", "policy_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_compiled_context_packs_workspace_snapshot_idx"
  ON "acceptance_compiled_context_packs" ("workspace_id", "source_snapshot_id");
