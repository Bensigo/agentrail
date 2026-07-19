ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "require_alignment" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "jace_approvals" ADD COLUMN IF NOT EXISTS "queue_entry_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jace_approvals" ADD CONSTRAINT "jace_approvals_queue_entry_id_queue_entries_id_fk" FOREIGN KEY ("queue_entry_id") REFERENCES "public"."queue_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
