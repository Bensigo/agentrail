ALTER TABLE "jace_approvals" ALTER COLUMN "workspace_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "jace_approvals" ADD COLUMN "chat_identity_id" uuid REFERENCES "chat_identities"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "jace_approvals" ADD CONSTRAINT "jace_approvals_workspace_or_identity_check" CHECK ("jace_approvals"."workspace_id" IS NOT NULL OR "jace_approvals"."chat_identity_id" IS NOT NULL);
