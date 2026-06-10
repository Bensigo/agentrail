ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "context_pack_file" text;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "selected_sources" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "retrieval_budget" jsonb;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "citations" jsonb;
