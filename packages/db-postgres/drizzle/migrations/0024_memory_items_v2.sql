-- memory_items v2 (issue #1032): typed entries + writer attribution.
--
-- Additive and non-destructive. We EXTEND the existing memory_items table — we
-- never drop or rewrite rows. Both new columns land NOT NULL with a safe DEFAULT
-- so the ALTERs backfill every pre-existing row in place:
--   type       — enum(decision|preference|fact), defaulted to the lowest-authority
--                label "fact" so historical rows never falsely claim to be a
--                locked "decision".
--   written_by — free-form writer attribution, backfilled from each row's existing
--                `source` (the closest attribution signal the old schema had),
--                falling back to "unknown" for any NULL/empty source.
--
-- The enum is created inside a DO block guarded on duplicate_object so re-running
-- on a DB that already has the type is a no-op (mirrors 0023's FK guard).
DO $$ BEGIN
 CREATE TYPE "public"."memory_type" AS ENUM('decision', 'preference', 'fact');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "type" "memory_type" DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "written_by" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
-- Backfill attribution from the pre-existing source signal (defaulted rows only).
UPDATE "memory_items"
   SET "written_by" = "source"
 WHERE "written_by" = 'unknown'
   AND "source" IS NOT NULL
   AND length(trim("source")) > 0;
