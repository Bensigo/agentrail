ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "baseline_window_days" integer NOT NULL DEFAULT 30;
