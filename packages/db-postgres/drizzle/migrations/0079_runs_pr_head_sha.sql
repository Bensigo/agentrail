-- #1630 — durable run-to-published-commit provenance for production human
-- false-green measurement. Hand-authored because drizzle-kit cannot generate
-- safely from this repository's incomplete snapshot chain.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pr_head_sha" text;
