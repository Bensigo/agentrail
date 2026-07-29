-- Conversation → investigation anchor (debugging design spec, "Investigation
-- artifact" section; docs/superpowers/specs/2026-07-29-jace-debugging-agent-
-- design.md, spec PR #1501). A THIRD, UNRELATED kind of anchor from
-- jace_sessions' existing workspace_id/chat_identity_id (tenant) and
-- anchored_brief_id (product idea) anchors — see schema/jace_sessions.ts's
-- doc-comment for the full distinction. Lets intake confirm which
-- investigation a conversation is about with the human exactly ONCE, then
-- skip straight to that investigation on every later turn in the same
-- conversation instead of re-asking. Nullable: most sessions never open an
-- investigation. ON DELETE SET NULL: a deleted investigation must not orphan
-- or break a live session.
--
-- MIGRATION SLOT: journal idx 61 / file 0060. Originally pre-assigned slot
-- 0059; shifted by one slot alongside 0058_investigations → 0059_investigations
-- — see that migration's header for why (0058 collided with the already-
-- landed 0058_thread_engagement.sql, PR #1500). Do not renumber this file.
ALTER TABLE "jace_sessions" ADD COLUMN IF NOT EXISTS "anchored_investigation_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jace_sessions" ADD CONSTRAINT "jace_sessions_anchored_investigation_id_investigations_id_fk" FOREIGN KEY ("anchored_investigation_id") REFERENCES "public"."investigations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
