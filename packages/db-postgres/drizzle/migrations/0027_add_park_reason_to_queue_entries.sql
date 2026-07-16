-- Add `park_reason` to queue_entries (issue #1239): a nullable, human-readable
-- reason recorded at every code path that parks an entry (a guardrail park —
-- duplicate content / rate limit / injection screen — or an unmet blocked-by
-- dependency) and cleared at every transition OUT of parked.
--
-- Nullable with no default: existing rows are unaffected (NULL means "no
-- recorded reason", which `formatParkReason` in the console falls back on,
-- rendering the `blocked_by` issue numbers instead).
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "park_reason" text;
