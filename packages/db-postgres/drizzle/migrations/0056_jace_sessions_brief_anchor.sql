-- Conversation → brief anchor (briefs design spec, "Retrieval — the whole
-- mismatch surface", step 3; docs/superpowers/specs/2026-07-28-jace-briefs-
-- durable-idea-understanding-design.md). A SECOND, UNRELATED kind of anchor
-- from jace_sessions' existing workspace_id/chat_identity_id anchor pair —
-- see schema/jace_sessions.ts's doc-comment for the full distinction. This
-- lets grill-me confirm which brief a conversation is about with the human
-- exactly ONCE, then skip straight to that brief on every later turn in the
-- same conversation instead of re-asking. Nullable: most sessions never
-- touch briefs. ON DELETE SET NULL: a deleted brief must not orphan or break
-- a live session — the conversation itself stays valid, it just loses its
-- pinned idea.
ALTER TABLE "jace_sessions" ADD COLUMN IF NOT EXISTS "anchored_brief_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jace_sessions" ADD CONSTRAINT "jace_sessions_anchored_brief_id_briefs_id_fk" FOREIGN KEY ("anchored_brief_id") REFERENCES "public"."briefs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
