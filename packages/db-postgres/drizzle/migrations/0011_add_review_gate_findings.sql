ALTER TABLE "review_gates" ADD COLUMN IF NOT EXISTS "findings" jsonb DEFAULT '[]'::jsonb;
