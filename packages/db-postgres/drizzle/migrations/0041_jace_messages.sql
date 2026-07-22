CREATE TABLE "jace_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" serial NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "conversation_key" text NOT NULL,
  "role" text NOT NULL,
  "text" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "jace_messages_role_check" CHECK ("jace_messages"."role" IN ('user', 'jace'))
);
--> statement-breakpoint
CREATE INDEX "jace_messages_workspace_conversation_seq_idx" ON "jace_messages" ("workspace_id","conversation_key","seq");
