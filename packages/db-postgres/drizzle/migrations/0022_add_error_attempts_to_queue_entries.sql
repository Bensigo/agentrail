-- Add error_attempts counter to queue_entries for bounded error-retry logic
-- (issue #890). Each execution error increments this counter; at 5 consecutive
-- errors the entry moves to escalated-to-human instead of blocked.
ALTER TABLE "queue_entries" ADD COLUMN IF NOT EXISTS "error_attempts" integer DEFAULT 0 NOT NULL;
