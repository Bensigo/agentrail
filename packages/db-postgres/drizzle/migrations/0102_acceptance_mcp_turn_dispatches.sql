CREATE TABLE IF NOT EXISTS "acceptance_mcp_turn_dispatches" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "credential_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE restrict,
  "task_context_key" text NOT NULL,
  "message_key" text NOT NULL,
  "intake_id" uuid NOT NULL REFERENCES "acceptance_intakes"("id") ON DELETE restrict,
  "inbound_message_id" uuid NOT NULL REFERENCES "acceptance_intake_messages"("id") ON DELETE restrict,
  "source_key" text NOT NULL,
  "message_sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reserved',
  "session_id" text,
  "continuation_token" text,
  "result_reason" text,
  "reserved_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_mcp_turn_dispatches_binding_check" CHECK (
    char_length("task_context_key") BETWEEN 1 AND 256
    AND "task_context_key" = btrim("task_context_key")
    AND "task_context_key" !~ '[[:cntrl:]]'
    AND char_length("message_key") BETWEEN 1 AND 256
    AND "message_key" = btrim("message_key")
    AND "message_key" !~ '[[:cntrl:]]'
    AND char_length("source_key") BETWEEN 1 AND 1024
    AND "source_key" = btrim("source_key")
    AND "source_key" !~ '[[:cntrl:]]'
    AND "message_sha256" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "acceptance_mcp_turn_dispatches_state_check" CHECK (
    "status" IN ('reserved', 'accepted', 'held')
    AND ("status" = 'reserved') = ("completed_at" IS NULL)
    AND ("status" = 'accepted') = ("session_id" IS NOT NULL)
    AND ("status" = 'accepted') = ("continuation_token" IS NOT NULL)
    AND ("status" = 'held') = ("result_reason" IS NOT NULL)
    AND ("status" <> 'reserved' OR (
      "session_id" IS NULL AND "continuation_token" IS NULL AND "result_reason" IS NULL
    ))
    AND ("status" <> 'accepted' OR (
      char_length("session_id") BETWEEN 1 AND 512 AND "session_id" !~ '[[:cntrl:]]'
      AND char_length("continuation_token") <= 1024 AND "continuation_token" !~ '[[:cntrl:]]'
      AND "result_reason" IS NULL
    ))
    AND ("status" <> 'held' OR (
      "session_id" IS NULL AND "continuation_token" IS NULL
      AND char_length("result_reason") BETWEEN 1 AND 256 AND "result_reason" !~ '[[:cntrl:]]'
    ))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_mcp_turn_dispatches_turn_key"
  ON "acceptance_mcp_turn_dispatches" ("workspace_id", "credential_id", "task_context_key", "message_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_mcp_turn_dispatches_message_key"
  ON "acceptance_mcp_turn_dispatches" ("inbound_message_id");
