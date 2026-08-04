-- #1602: durable brief -> queue provenance. Additive and nullable by design:
-- old, externally-created, and unproven queue entries remain unknown rather
-- than being reconstructed from mutable session state or text matching.
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "alignment_brief_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_alignment_brief_id_briefs_id_fk"
    FOREIGN KEY ("alignment_brief_id") REFERENCES "public"."briefs"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "queue_entries_alignment_brief_id_idx"
  ON "queue_entries" USING btree ("alignment_brief_id");
