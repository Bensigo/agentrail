-- Server-derived selected-route dispatch preparation. This is an aggregate
-- per immutable head cycle, not a mutable worker queue or vendor transport.
CREATE TABLE IF NOT EXISTS "acceptance_correction_dispatches" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "repo" text NOT NULL, "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL, "head_cycle_id" uuid NOT NULL, "authority_generation" integer NOT NULL,
  "source_snapshot_id" uuid NOT NULL REFERENCES "acceptance_context_pack_snapshots"("id") ON DELETE restrict,
  "review_job_id" uuid NOT NULL REFERENCES "review_jobs"("id") ON DELETE restrict,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL, "acceptance_contract_sha256" text NOT NULL,
  "packet_ids" jsonb NOT NULL, "packet_set_sha256" text NOT NULL, "correction_packet_payload_set_sha256" text NOT NULL,
  "compiled_pack_id" uuid NOT NULL REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "compiled_pack_sha256" text NOT NULL, "compiler_version" text NOT NULL, "policy_version" text NOT NULL,
  "json_sha256" text NOT NULL, "markdown_sha256" text NOT NULL, "source_custody_identity_sha256" text NOT NULL,
  "route_id" uuid NOT NULL REFERENCES "acceptance_builder_routes"("id") ON DELETE restrict,
  "route_adapter" text NOT NULL, "route_configuration_version" integer NOT NULL, "route_snapshot" jsonb NOT NULL, "route_snapshot_sha256" text NOT NULL,
  "dispatch_protocol_version" integer NOT NULL DEFAULT 1, "dispatch_identity_sha256" text NOT NULL,
  "delivery_state" text NOT NULL DEFAULT 'queued', "agent_state" text NOT NULL DEFAULT 'not_observed',
  "findings_state" text NOT NULL DEFAULT 'not_started', "activation_state" text NOT NULL DEFAULT 'not_started', "carrier" text NOT NULL,
  "invalidated_at" timestamp with time zone, "invalidation_reason" text,
  "successor_head_sha" text, "successor_head_cycle_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(), "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_correction_dispatches_record_cycle_key" UNIQUE ("record_id", "head_cycle_id"),
  CONSTRAINT "acceptance_correction_dispatches_head_check" CHECK ("head_sha" ~ '^[A-Fa-f0-9]{40}$' AND "authority_generation" >= 0 AND char_length("repo") BETWEEN 3 AND 512 AND btrim("repo") = "repo" AND "repo" ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' AND "pr_number" > 0),
  CONSTRAINT "acceptance_correction_dispatches_contract_check" CHECK ("acceptance_contract_version" > 0 AND "acceptance_contract_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_correction_dispatches_packet_check" CHECK (jsonb_typeof("packet_ids") = 'array' AND jsonb_array_length("packet_ids") BETWEEN 1 AND 100 AND "packet_set_sha256" ~ '^[A-Fa-f0-9]{64}$' AND "correction_packet_payload_set_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_correction_dispatches_pack_check" CHECK ("compiled_pack_sha256" ~ '^[A-Fa-f0-9]{64}$' AND "source_custody_identity_sha256" ~ '^[A-Fa-f0-9]{64}$' AND "json_sha256" ~ '^[A-Fa-f0-9]{64}$' AND "markdown_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_correction_dispatches_version_check" CHECK (char_length("compiler_version") BETWEEN 1 AND 128 AND btrim("compiler_version") = "compiler_version" AND "compiler_version" !~ '[[:cntrl:]]' AND char_length("policy_version") BETWEEN 1 AND 128 AND btrim("policy_version") = "policy_version" AND "policy_version" !~ '[[:cntrl:]]' AND "route_configuration_version" > 0 AND "dispatch_protocol_version" = 1),
  CONSTRAINT "acceptance_correction_dispatches_route_check" CHECK ("route_adapter" IN ('github_codex', 'github_claude', 'durable_github_fallback', 'durable_jace_fallback') AND jsonb_typeof("route_snapshot") = 'object' AND "route_snapshot_sha256" ~ '^[A-Fa-f0-9]{64}$' AND "dispatch_identity_sha256" ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT "acceptance_correction_dispatches_delivery_state_check" CHECK ("delivery_state" IN ('queued', 'carrier_accepted', 'ambiguous_hold', 'failed', 'fallback')),
  CONSTRAINT "acceptance_correction_dispatches_agent_state_check" CHECK ("agent_state" IN ('not_observed', 'started', 'acknowledged', 'failed')),
  CONSTRAINT "acceptance_correction_dispatches_findings_state_check" CHECK ("findings_state" IN ('not_started', 'reserved', 'terminal', 'ambiguous_hold', 'failed')),
  CONSTRAINT "acceptance_correction_dispatches_activation_state_check" CHECK ("activation_state" IN ('not_started', 'reserved', 'carrier_accepted', 'ambiguous_hold', 'failed', 'fallback')),
  CONSTRAINT "acceptance_correction_dispatches_carrier_check" CHECK ("carrier" IN ('github_comment', 'durable_notice')),
  CONSTRAINT "acceptance_correction_dispatches_invalidation_check" CHECK (("invalidated_at" IS NULL) = ("invalidation_reason" IS NULL) AND ("successor_head_sha" IS NULL) = ("successor_head_cycle_id" IS NULL) AND ("successor_head_sha" IS NULL OR "successor_head_sha" ~ '^[A-Fa-f0-9]{40}$') AND ("invalidation_reason" IS NULL OR "invalidation_reason" IN ('head_advanced', 'authority_blocked', 'terminal', 'reconciled')))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_correction_dispatches_workspace_record_idx"
  ON "acceptance_correction_dispatches" ("workspace_id", "record_id", "created_at");
