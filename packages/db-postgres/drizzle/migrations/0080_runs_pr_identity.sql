-- #1630 — normalized repository and pull-request identity. This follows
-- 0078_queue_entry_brief_lineage so the independently reviewable lineage
-- stack and production-outcome stack can land in either approved order.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pr_repo" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pr_number" integer;
