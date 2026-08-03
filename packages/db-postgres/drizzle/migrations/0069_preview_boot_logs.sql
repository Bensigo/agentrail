-- Optional boot-log evidence for preview boots. The worker may upload a
-- text/plain boot.log artifact under the existing review-evidence object-key
-- family and persist its key here. Nullable/no default by design: storage is
-- best-effort and disabled/unavailable storage must never make a boot status
-- transition fail.
ALTER TABLE "preview_boots" ADD COLUMN IF NOT EXISTS "boot_log_key" text;
