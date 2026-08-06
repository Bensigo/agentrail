-- A legacy handoff may remain representable without a credential, but every
-- builder-facing read fails closed until an owner creates a bound handoff.
ALTER TABLE "acceptance_builder_handoffs"
  ADD COLUMN IF NOT EXISTS "agent_mcp_credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "acceptance_builder_handoffs"
  ADD CONSTRAINT "acceptance_builder_handoffs_agent_mcp_credential_id_api_keys_id_fk"
  FOREIGN KEY ("agent_mcp_credential_id") REFERENCES "public"."api_keys"("id")
  ON DELETE restrict;
