ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "last_liveness_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "last_liveness_at" timestamp with time zone;
