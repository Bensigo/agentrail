ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "estimated_budget_usd" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "model_override" text;
