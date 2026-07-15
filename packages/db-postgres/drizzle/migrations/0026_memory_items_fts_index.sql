-- FTS index for memory_items (issue #1215): backs the `retrieveMemory` BM25 +
-- heuristic-rerank retriever's step-1 prefilter (websearch_to_tsquery over
-- content, scoped by workspace_id).
--
-- Expression GIN index on the two-argument `to_tsvector('english', content)` —
-- the two-arg form is IMMUTABLE (pins the text-search config so it can be
-- indexed), unlike the one-arg `to_tsvector(content)` which is STABLE and
-- reads the session-local config.
--
-- IF NOT EXISTS makes this idempotent: safe to re-run against a DB that
-- already has the index (mirrors the ADD COLUMN IF NOT EXISTS pattern used in
-- 0025).
CREATE INDEX IF NOT EXISTS "memory_items_content_fts_idx"
  ON "memory_items"
  USING gin (to_tsvector('english', "content"));
