ALTER TABLE "jace_sessions" ALTER COLUMN "workspace_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "jace_sessions" ADD COLUMN "chat_identity_id" uuid REFERENCES "chat_identities"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "jace_sessions" ADD CONSTRAINT "jace_sessions_workspace_or_identity_check" CHECK ("jace_sessions"."workspace_id" IS NOT NULL OR "jace_sessions"."chat_identity_id" IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX "jace_sessions_intro_conversation_idx" ON "jace_sessions" USING btree ("channel","conversation_key") WHERE "jace_sessions"."workspace_id" IS NULL;
