ALTER TABLE "dependency_watch_observations"
  ADD COLUMN IF NOT EXISTS "candidate_fingerprint" text;
