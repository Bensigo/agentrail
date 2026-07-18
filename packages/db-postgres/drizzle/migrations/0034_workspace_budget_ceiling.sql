ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "monthly_budget_usd" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "budget_exhausted_notified_period" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_workspace_id_created_at_idx" ON "runs" USING btree ("workspace_id","created_at");
