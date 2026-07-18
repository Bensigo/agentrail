ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "hosted_execution" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'self_hosted' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" IN ('self_hosted', 'fleet'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_one_active_fleet_key_idx" ON "api_keys" USING btree ("workspace_id") WHERE "api_keys"."kind" = 'fleet' AND "api_keys"."revoked_at" IS NULL;
