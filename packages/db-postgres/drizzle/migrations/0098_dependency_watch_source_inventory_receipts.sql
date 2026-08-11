-- Append-only, source-free exact-tree custody for bounded Go watch observations.
-- This receipt is not canonical dependency evidence and grants no draft,
-- approval, Pack, builder, or execution capability.
ALTER TABLE "dependency_watch_observations"
  ADD COLUMN IF NOT EXISTS "source_inventory_receipt" jsonb,
  ADD COLUMN IF NOT EXISTS "source_inventory_receipt_sha256" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dependency_watch_observations"
    ADD CONSTRAINT "dependency_watch_observations_source_inventory_receipt_check"
    CHECK (
      ("source_inventory_receipt" IS NULL AND "source_inventory_receipt_sha256" IS NULL)
      OR (
        "source_inventory_receipt" IS NOT NULL
        AND "source_inventory_receipt_sha256" IS NOT NULL
        AND "source_inventory_receipt_sha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("source_inventory_receipt") = 'object'
        AND "source_inventory_receipt" ->> 'kind' = 'github_exact_tree_dependency_source_inventory'
        AND "source_inventory_receipt" ->> 'schemaVersion' = '1'
        AND "source_inventory_receipt" #>> '{identity,ecosystem}' = 'go'
        AND "source_inventory_receipt" #>> '{identity,manager}' = 'go-modules'
        AND "source_inventory_receipt" #>> '{identity,profile}' = 'go_github_exact_tree_source_inventory_v1'
        AND "source_inventory_receipt" ->> 'identitySha256' = "source_inventory_receipt_sha256"
        AND "baseline_sha" = "source_inventory_receipt" #>> '{authority,commitSha}'
        AND "source_inventory_receipt" #>> '{requiredFiles,0,path}' = 'go.mod'
        AND "source_inventory_receipt" #>> '{requiredFiles,1,path}' = 'go.sum'
        AND "selected_file_hashes" = jsonb_build_object(
          'go.mod', "source_inventory_receipt" #>> '{requiredFiles,0,contentSha256}',
          'go.sum', "source_inventory_receipt" #>> '{requiredFiles,1,contentSha256}'
        )
        AND right("observation_key", 72) = ':source:' || "source_inventory_receipt_sha256"
        AND octet_length("source_inventory_receipt"::text) <= 16777216
      )
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
