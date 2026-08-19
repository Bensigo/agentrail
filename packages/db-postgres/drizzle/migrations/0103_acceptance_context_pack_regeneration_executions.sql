CREATE TABLE IF NOT EXISTS "acceptance_context_pack_regeneration_executions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "record_id" uuid NOT NULL REFERENCES "change_records"("id") ON DELETE cascade,
  "request_event_id" uuid NOT NULL REFERENCES "change_record_events"("id") ON DELETE restrict,
  "request_event_key" text NOT NULL,
  "parent_execution_id" uuid,
  "source_snapshot_id" uuid NOT NULL REFERENCES "acceptance_context_pack_snapshots"("id") ON DELETE restrict,
  "prior_compiled_pack_id" uuid NOT NULL REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "head_cycle_id" uuid NOT NULL,
  "authority_generation" integer NOT NULL,
  "acceptance_contract_id" uuid NOT NULL REFERENCES "acceptance_contracts"("id") ON DELETE restrict,
  "acceptance_contract_version" integer NOT NULL,
  "acceptance_contract_sha256" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 1,
  "claimed_by" text,
  "lease_token_sha256" text,
  "lease_expires_at" timestamp with time zone,
  "execution_deadline_at" timestamp with time zone,
  "replacement_compiled_pack_id" uuid REFERENCES "acceptance_compiled_context_packs"("id") ON DELETE restrict,
  "outcome_reason" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "acceptance_context_pack_regeneration_executions_parent_fk"
    FOREIGN KEY ("parent_execution_id")
    REFERENCES "acceptance_context_pack_regeneration_executions"("id") ON DELETE restrict,
  CONSTRAINT "acceptance_context_pack_regeneration_executions_binding_check" CHECK (
    char_length("request_event_key") BETWEEN 1 AND 1024
    AND char_length("repo") BETWEEN 3 AND 201
    AND "repo" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
    AND "pr_number" > 0
    AND "head_sha" ~ '^[a-f0-9]{40}$'
    AND "authority_generation" >= 0
    AND "acceptance_contract_version" > 0
    AND "acceptance_contract_sha256" ~ '^[a-f0-9]{64}$'
    AND "reason" IN ('stale', 'inadequate')
    AND ("parent_execution_id" IS NULL OR "parent_execution_id" <> "id")
    AND "max_attempts" = 1
    AND "attempt_count" BETWEEN 0 AND "max_attempts"
  ),
  CONSTRAINT "acceptance_context_pack_regeneration_executions_state_check" CHECK (
    "status" IN ('queued', 'running', 'replaced', 'unchanged', 'not_current', 'not_proven', 'held')
    AND (("status" = 'running') = ("claimed_by" IS NOT NULL))
    AND (("status" = 'running') = ("lease_token_sha256" IS NOT NULL))
    AND (("status" = 'running') = ("lease_expires_at" IS NOT NULL))
    AND (("attempt_count" = 0) = ("execution_deadline_at" IS NULL))
    AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= "execution_deadline_at")
    AND ("lease_token_sha256" IS NULL OR "lease_token_sha256" ~ '^[a-f0-9]{64}$')
    AND (("status" IN ('queued', 'running')) = ("completed_at" IS NULL))
    AND (("status" NOT IN ('queued', 'running')) = ("outcome_reason" IS NOT NULL))
    AND (("status" = 'replaced') = ("replacement_compiled_pack_id" IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_request_key"
  ON "acceptance_context_pack_regeneration_executions" ("request_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regen_root_lineage_key"
  ON "acceptance_context_pack_regeneration_executions" (
    "workspace_id",
    "record_id",
    "prior_compiled_pack_id",
    "head_cycle_id",
    "acceptance_contract_id",
    "acceptance_contract_version",
    "acceptance_contract_sha256"
  ) WHERE "parent_execution_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regen_retry_child_key"
  ON "acceptance_context_pack_regeneration_executions" ("parent_execution_id")
  WHERE "parent_execution_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_claim_idx"
  ON "acceptance_context_pack_regeneration_executions" ("status", "lease_expires_at", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_record_idx"
  ON "acceptance_context_pack_regeneration_executions" ("workspace_id", "record_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_acceptance_context_pack_regeneration_execution_custody"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "change_records" r
    WHERE r."id" = NEW."record_id"
      AND r."workspace_id" = NEW."workspace_id"
      AND r."repo" = NEW."repo"
      AND r."pr_number" = NEW."pr_number"
  ) OR NOT EXISTS (
    SELECT 1 FROM "change_record_events" e
    WHERE e."id" = NEW."request_event_id"
      AND e."record_id" = NEW."record_id"
      AND e."event_key" = NEW."request_event_key"
  ) OR NOT EXISTS (
    SELECT 1 FROM "acceptance_context_pack_snapshots" s
    WHERE s."id" = NEW."source_snapshot_id"
      AND s."workspace_id" = NEW."workspace_id"
      AND s."record_id" = NEW."record_id"
      AND s."review_job_id" = NEW."head_cycle_id"
      AND lower(s."expected_head_sha") = lower(NEW."head_sha")
      AND s."acceptance_contract_id" = NEW."acceptance_contract_id"
      AND s."acceptance_contract_version" = NEW."acceptance_contract_version"
      AND lower(s."acceptance_contract_sha256") = lower(NEW."acceptance_contract_sha256")
  ) OR NOT EXISTS (
    SELECT 1 FROM "acceptance_compiled_context_packs" p
    WHERE p."id" = NEW."prior_compiled_pack_id"
      AND p."workspace_id" = NEW."workspace_id"
      AND p."source_snapshot_id" = NEW."source_snapshot_id"
  ) OR NOT EXISTS (
    SELECT 1 FROM "acceptance_contracts" c
    WHERE c."id" = NEW."acceptance_contract_id"
      AND c."record_id" = NEW."record_id"
      AND c."version" = NEW."acceptance_contract_version"
  ) THEN
    RAISE EXCEPTION 'Context Pack regeneration execution custody mismatch';
  END IF;

  IF NEW."replacement_compiled_pack_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "acceptance_compiled_context_packs" p
    JOIN "acceptance_context_pack_snapshots" s ON s."id" = p."source_snapshot_id"
    WHERE p."id" = NEW."replacement_compiled_pack_id"
      AND p."workspace_id" = NEW."workspace_id"
      AND s."workspace_id" = NEW."workspace_id"
      AND s."record_id" = NEW."record_id"
  ) THEN
    RAISE EXCEPTION 'Context Pack regeneration replacement custody mismatch';
  END IF;

  IF NEW."parent_execution_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "acceptance_context_pack_regeneration_executions" parent
    WHERE parent."id" = NEW."parent_execution_id"
      AND parent."parent_execution_id" IS NULL
      AND parent."workspace_id" = NEW."workspace_id"
      AND parent."record_id" = NEW."record_id"
      AND parent."prior_compiled_pack_id" = NEW."prior_compiled_pack_id"
      AND parent."head_cycle_id" = NEW."head_cycle_id"
      AND parent."acceptance_contract_id" = NEW."acceptance_contract_id"
      AND parent."acceptance_contract_version" = NEW."acceptance_contract_version"
      AND parent."acceptance_contract_sha256" = NEW."acceptance_contract_sha256"
  ) THEN
    RAISE EXCEPTION 'Context Pack regeneration parent custody mismatch';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "acceptance_context_pack_regeneration_executions_custody_trigger"
BEFORE INSERT OR UPDATE ON "acceptance_context_pack_regeneration_executions"
FOR EACH ROW EXECUTE FUNCTION "validate_acceptance_context_pack_regeneration_execution_custody"();
