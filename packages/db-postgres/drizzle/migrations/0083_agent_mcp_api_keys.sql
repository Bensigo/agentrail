ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_kind_check";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_check" CHECK ("api_keys"."kind" IN ('self_hosted', 'fleet', 'agent_mcp'));
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scope_check" CHECK (
  (
    "api_keys"."kind" = 'agent_mcp'
    AND cardinality("api_keys"."scopes") > 0
    AND "api_keys"."scopes" <@ ARRAY['acceptance:read', 'acceptance:draft:write', 'acceptance:context:write']::text[]
  )
  OR
  (
    "api_keys"."kind" IN ('self_hosted', 'fleet')
    AND "api_keys"."scopes" = ARRAY[]::text[]
  )
);
