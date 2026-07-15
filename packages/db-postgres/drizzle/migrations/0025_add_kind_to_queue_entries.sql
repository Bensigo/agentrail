-- Add `kind` to queue_entries (issue #1149): signals what a claimed entry is —
-- 'issue' (default — run the SDLC spine against a GitHub/CLI issue) or 'onboard'
-- (index a freshly connected repo and seed workspace memory).
--
-- Additive and backward-compatible in both directions. The column lands NOT NULL
-- with a safe DEFAULT so the ALTER backfills every pre-existing row in place as
-- 'issue' — old queue rows, old runners that never read `kind`, and old servers
-- that never send it all keep working unchanged.
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'issue' NOT NULL;
