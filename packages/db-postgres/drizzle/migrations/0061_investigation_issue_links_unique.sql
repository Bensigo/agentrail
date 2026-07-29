-- Investigation issue-link idempotency (debugging design spec, spec PR
-- #1501; Task 12 fix round 1 — review finding: the approval seam's link
-- write needs to be ATOMICALLY idempotent, not merely guarded by an
-- application-level SELECT-then-INSERT check, which leaves a TOCTOU race
-- window open under concurrent/retried publish calls).
--
-- `stampPublishedIssueUrl` (jace_approvals.published_issue_url) already
-- solves this identical problem at the database level — a guarded UPDATE
-- whose idempotent-replay contract callers rely on. This migration gives
-- `investigation_issue_links` the same guarantee for the SAME reason:
-- `POST /api/v1/runner/approvals/[id]/published` can genuinely run twice
-- for one approval (that endpoint's own idempotent-stamp-replay contract),
-- and each run calls `linkInvestigationIssue`
-- (`packages/db-postgres/src/queries/investigations.ts`) unconditionally —
-- no read-check first. The unique index below is what makes the SECOND
-- call's `INSERT ... ON CONFLICT DO NOTHING` a true no-op, concurrent-safe,
-- rather than a race between a SELECT and a later INSERT.
--
-- Hand-authored, NOT `drizzle-kit generate`d — same posture as every
-- migration since 0004 in this checkout (idempotent statement shape:
-- `CREATE UNIQUE INDEX IF NOT EXISTS`, safe to re-run).
--
-- MIGRATION SLOT: journal idx 62 / file 0061. Fix-round addition (Task 12
-- review, on top of the already-landed 0059/0060 pair) — the next free
-- slot after `0060_jace_sessions_investigation_anchor.sql`. No collision to
-- work around here; this is a plain sequential slot. Do not renumber this
-- file.
CREATE UNIQUE INDEX IF NOT EXISTS "investigation_issue_links_unique"
  ON "investigation_issue_links"
  USING btree ("investigation_id", "repo", "issue_number");
