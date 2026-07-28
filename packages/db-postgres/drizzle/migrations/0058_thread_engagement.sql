ALTER TABLE "jace_sessions" ADD COLUMN IF NOT EXISTS "engagement_dormant_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jace_sessions" ADD COLUMN IF NOT EXISTS "engaged_speaker_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jace_sessions_channel_conversation_idx" ON "jace_sessions" USING btree ("channel","conversation_key");
