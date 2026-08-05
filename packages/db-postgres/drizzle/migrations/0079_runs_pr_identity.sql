-- #1630 — durable normalized run-to-PR identity. The URL is useful for people;
-- this tuple is the machine join key for provenance-first outcome metrics.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pr_repo" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pr_number" integer;
