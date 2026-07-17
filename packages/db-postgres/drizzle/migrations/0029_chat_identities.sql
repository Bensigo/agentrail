CREATE TABLE "chat_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform" text NOT NULL,
  "platform_user_id" text NOT NULL,
  "display_name" text,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "link_token" text,
  "link_token_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "chat_identities_platform_user_unique" UNIQUE("platform","platform_user_id"),
  CONSTRAINT "chat_identities_link_token_unique" UNIQUE("link_token")
);
