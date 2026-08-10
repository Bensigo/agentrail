-- R8.2c exact-head invalidation boundary.
--
-- `head_shas` is immutable history and cannot answer which PR tip is current.
-- Keep the new pointer nullable so existing rows are not assigned a guessed
-- head. Active pre-migration work is fail-closed below; a fresh signed PR
-- event must establish the pointer and admit a deterministic exact-head job.
ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "current_pr_head_sha" text;
ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "current_pr_head_cycle_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'change_records'
      AND column_name = 'current_pr_head_authoritative'
  ) THEN
    ALTER TABLE "change_records"
      ADD COLUMN "current_pr_head_authoritative" boolean NOT NULL DEFAULT false;

    UPDATE "review_jobs"
    SET "state" = 'superseded',
        "updated_at" = now()
    WHERE "state" IN ('queued', 'running');

    UPDATE "preview_boots"
    SET "status" = 'torn_down',
        "reason" = 'current Acceptance Record cycle unavailable after migration',
        "updated_at" = now()
    WHERE "status" IN ('pending', 'claimed', 'booting', 'ready');
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "change_records"
    ADD CONSTRAINT "change_records_current_pr_head_history_check"
    CHECK (
      (
        "current_pr_head_sha" IS NULL OR (
          "current_pr_head_sha" ~ '^[A-Fa-f0-9]{40}$'
          AND "current_pr_head_sha" = ANY("head_shas")
        )
      ) AND (
        ("current_pr_head_sha" IS NULL) = ("current_pr_head_cycle_id" IS NULL)
      ) AND (
        NOT "current_pr_head_authoritative" OR (
          "current_pr_head_sha" IS NOT NULL AND "current_pr_head_cycle_id" IS NOT NULL
        )
      )
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
