CREATE TABLE "channel_inbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "conversation_key" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'message',
  "sender_id" text NOT NULL DEFAULT '',
  "sender_display" text NOT NULL DEFAULT '',
  "provider_message_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "channel_inbox_provider_message_unique" UNIQUE("channel","provider_message_id")
);
--> statement-breakpoint
CREATE INDEX "channel_inbox_claim_idx" ON "channel_inbox" ("state","next_attempt_at","created_at");
--> statement-breakpoint
CREATE TABLE "jace_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "conversation_key" text NOT NULL,
  "eve_session_id" text,
  "status" text NOT NULL DEFAULT 'active',
  "last_activity_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "jace_sessions_conversation_unique" UNIQUE("workspace_id","channel","conversation_key")
);
--> statement-breakpoint
CREATE TABLE "jace_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "jace_sessions"("id") ON DELETE CASCADE,
  "eve_session_id" text NOT NULL,
  "request_id" text NOT NULL,
  "callback_token" text NOT NULL,
  "tool_name" text NOT NULL,
  "tool_input" jsonb NOT NULL,
  "approve_option_id" text NOT NULL,
  "deny_option_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "published_issue_url" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  CONSTRAINT "jace_approvals_request_unique" UNIQUE("eve_session_id","request_id"),
  CONSTRAINT "jace_approvals_callback_token_unique" UNIQUE("callback_token")
);
