-- Provenance: hand-authored (subscription platform slice 0 — spec 2026-07-29-subscription-platform-design.md §9).
-- Seat/capacity counting reads. Idempotent by IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS chat_identities_user_id_idx ON chat_identities (user_id);
CREATE INDEX IF NOT EXISTS channel_inbox_workspace_created_idx ON channel_inbox (workspace_id, created_at);
