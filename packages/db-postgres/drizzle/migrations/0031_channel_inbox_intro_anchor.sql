ALTER TABLE "channel_inbox" ALTER COLUMN "workspace_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_inbox" ADD COLUMN "chat_identity_id" uuid REFERENCES "chat_identities"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "channel_inbox" ADD CONSTRAINT "channel_inbox_workspace_or_identity_check" CHECK ("channel_inbox"."workspace_id" IS NOT NULL OR "channel_inbox"."chat_identity_id" IS NOT NULL);
