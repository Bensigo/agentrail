ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_kind_check";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check"
  CHECK ("api_keys"."kind" IN ('self_hosted', 'fleet', 'agent_mcp'));
