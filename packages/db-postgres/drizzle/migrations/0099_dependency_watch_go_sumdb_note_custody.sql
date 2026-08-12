CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watch_observations_source_custody_unique_idx"
  ON "dependency_watch_observations" ("id", "workspace_id", "watch_id", "repository_id", "source_inventory_receipt_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watches_custody_identity_idx"
  ON "dependency_watches" ("id", "workspace_id", "repository_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dependency_watch_go_sumdb_signed_tree_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "watch_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "source_observation_id" uuid NOT NULL,
  "source_inventory_receipt_sha256" text NOT NULL,
  "format_profile" text NOT NULL,
  "signed_tree_note_base64" text NOT NULL,
  "signed_tree_note_sha256" text NOT NULL,
  "expected_prior_signed_tree_note_sha256" text,
  "expected_prior_generation" integer,
  "generation" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dependency_watch_go_sumdb_notes_watch_generation_unique"
    UNIQUE ("watch_id", "generation"),
  CONSTRAINT "dependency_watch_go_sumdb_notes_watch_note_unique"
    UNIQUE ("watch_id", "signed_tree_note_sha256"),
  CONSTRAINT "dependency_watch_go_sumdb_notes_lineage_identity_unique"
    UNIQUE ("workspace_id", "watch_id", "repository_id", "signed_tree_note_sha256", "generation"),
  CONSTRAINT "dependency_watch_go_sumdb_notes_watch_identity_fk"
    FOREIGN KEY ("watch_id", "workspace_id", "repository_id")
    REFERENCES "dependency_watches"("id", "workspace_id", "repository_id") ON DELETE RESTRICT,
  CONSTRAINT "dependency_watch_go_sumdb_notes_source_custody_fk"
    FOREIGN KEY ("source_observation_id", "workspace_id", "watch_id", "repository_id", "source_inventory_receipt_sha256")
    REFERENCES "dependency_watch_observations"("id", "workspace_id", "watch_id", "repository_id", "source_inventory_receipt_sha256") ON DELETE RESTRICT,
  CONSTRAINT "dependency_watch_go_sumdb_notes_prior_note_fk"
    FOREIGN KEY ("workspace_id", "watch_id", "repository_id", "expected_prior_signed_tree_note_sha256", "expected_prior_generation")
    REFERENCES "dependency_watch_go_sumdb_signed_tree_notes"("workspace_id", "watch_id", "repository_id", "signed_tree_note_sha256", "generation") ON DELETE RESTRICT,
  CONSTRAINT "dependency_watch_go_sumdb_notes_format_check" CHECK (
    "format_profile" = 'go_sumdb_v1_retained_signed_tree_note_bytes'
  ),
  CONSTRAINT "dependency_watch_go_sumdb_notes_lineage_check" CHECK (
    ("generation" = 0 AND "expected_prior_signed_tree_note_sha256" IS NULL AND "expected_prior_generation" IS NULL)
    OR (
      "generation" > 0
      AND "expected_prior_signed_tree_note_sha256" IS NOT NULL
      AND "expected_prior_generation" = "generation" - 1
    )
  ),
  CONSTRAINT "dependency_watch_go_sumdb_notes_sha_check" CHECK (
    "signed_tree_note_sha256" ~ '^[0-9a-f]{64}$'
    AND "source_inventory_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND (
      "expected_prior_signed_tree_note_sha256" IS NULL
      OR (
        "expected_prior_signed_tree_note_sha256" ~ '^[0-9a-f]{64}$'
        AND "expected_prior_signed_tree_note_sha256" <> "signed_tree_note_sha256"
      )
    )
  ),
  CONSTRAINT "dependency_watch_go_sumdb_notes_bytes_check" CHECK (
    "signed_tree_note_base64" ~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    AND octet_length("signed_tree_note_base64") BETWEEN 4 AND 5464
    AND octet_length(decode("signed_tree_note_base64", 'base64')) BETWEEN 1 AND 4096
    AND replace(encode(decode("signed_tree_note_base64", 'base64'), 'base64'), E'\n', '') = "signed_tree_note_base64"
    AND encode(sha256(decode("signed_tree_note_base64", 'base64')), 'hex') = "signed_tree_note_sha256"
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dependency_watch_go_sumdb_notes_watch_prior_idx"
  ON "dependency_watch_go_sumdb_signed_tree_notes" ("watch_id", "expected_prior_signed_tree_note_sha256")
  WHERE "expected_prior_signed_tree_note_sha256" IS NOT NULL;
