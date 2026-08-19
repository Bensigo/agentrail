import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

describe("0103 Context Pack regeneration executions migration", () => {
  it("is journaled and enforces queue, exact binding, lease, and replacement custody", async () => {
    const [sql, journalText] = await Promise.all([
      readFile(fileURLToPath(new URL("../../drizzle/migrations/0103_acceptance_context_pack_regeneration_executions.sql", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries).toContainEqual(expect.objectContaining({ idx: 108, tag: "0103_acceptance_context_pack_regeneration_executions" }));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_pack_regeneration_executions"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_request_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regen_root_lineage_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regen_retry_child_key"');
    expect(sql).toContain('"parent_execution_id" uuid');
    expect(sql).toContain('FOREIGN KEY ("parent_execution_id")');
    expect(sql).toContain('CREATE TRIGGER "acceptance_context_pack_regeneration_executions_custody_trigger"');
    expect(sql).toContain('"replacement_compiled_pack_id" uuid REFERENCES "acceptance_compiled_context_packs"');
    expect(sql).toContain('"lease_token_sha256" IS NOT NULL');
    expect(sql).toContain('"execution_deadline_at" timestamp with time zone');
    expect(sql).toContain('"intent_generation" integer NOT NULL DEFAULT 1');
    expect(sql).toContain('"acceptance_contract_sha256",\n    "intent_generation"');
    expect(sql).toContain('"lease_expires_at" <= "execution_deadline_at"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "generation_status" text NOT NULL DEFAULT \'active\'');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "regeneration_execution_id" uuid');
    expect(sql).toContain('"generation_status" IN (\'provisional\', \'active\', \'superseded\')');
    expect(sql).toContain('"status" = \'replaced\'');
  });
});

describe.skipIf(!process.env["DATABASE_URL"])("0103 legacy request migration compatibility", () => {
  it("preserves a pre-0103 v1 request without backfilling execution authority", async () => {
    const migration = await readFile(fileURLToPath(new URL(
      "../../drizzle/migrations/0103_acceptance_context_pack_regeneration_executions.sql",
      import.meta.url,
    )), "utf8");
    const schema = `regen_migration_${randomUUID().replaceAll("-", "")}`;
    const client = postgres(process.env["DATABASE_URL"]!, { max: 1 });
    const workspaceId = randomUUID();
    const recordId = randomUUID();
    const legacyEventId = randomUUID();
    const v3EventId = randomUUID();
    const executionId = randomUUID();
    const snapshotId = randomUUID();
    const packId = randomUUID();
    const contractId = randomUUID();
    const cycleId = randomUUID();
    const headSha = "a".repeat(40);
    const contractSha = "b".repeat(64);
    const repo = "acme/widgets";
    const legacyEventKey = `context-pack-regeneration:${packId}:stale:${workspaceId}`;
    const legacyPayload = {
      kind: "acceptance_context_pack_regeneration_request",
      version: 1,
      workspaceId,
      recordId,
      sourceSnapshotId: snapshotId,
      compiledPackId: packId,
      repo,
      prNumber: 41,
      headSha,
      headCycleId: cycleId,
      authorityGeneration: 1,
      acceptanceContract: { id: contractId, version: 1, sha256: contractSha },
      reason: "stale",
      requestedBy: `user:${workspaceId}`,
      requestedRole: "owner",
      authority: "request_only",
      status: "request_recorded",
    };
    try {
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
      await client.unsafe(`SET search_path TO "${schema}"`);
      await client.unsafe(`
        CREATE TABLE workspaces (id uuid PRIMARY KEY);
        CREATE TABLE change_records (
          id uuid PRIMARY KEY,
          workspace_id uuid NOT NULL REFERENCES workspaces(id),
          repo text NOT NULL,
          pr_number integer NOT NULL
        );
        CREATE TABLE change_record_events (
          id uuid PRIMARY KEY,
          record_id uuid NOT NULL REFERENCES change_records(id),
          event_key text NOT NULL,
          payload_ref jsonb NOT NULL
        );
        CREATE TABLE acceptance_contracts (
          id uuid PRIMARY KEY,
          record_id uuid NOT NULL REFERENCES change_records(id),
          version integer NOT NULL
        );
        CREATE TABLE acceptance_context_pack_snapshots (
          id uuid PRIMARY KEY,
          workspace_id uuid NOT NULL REFERENCES workspaces(id),
          record_id uuid NOT NULL REFERENCES change_records(id),
          review_job_id uuid NOT NULL,
          expected_head_sha text NOT NULL,
          acceptance_contract_id uuid NOT NULL REFERENCES acceptance_contracts(id),
          acceptance_contract_version integer NOT NULL,
          acceptance_contract_sha256 text NOT NULL,
          created_at timestamp with time zone NOT NULL DEFAULT now()
        );
        CREATE TABLE acceptance_compiled_context_packs (
          id uuid PRIMARY KEY,
          workspace_id uuid NOT NULL REFERENCES workspaces(id),
          source_snapshot_id uuid NOT NULL REFERENCES acceptance_context_pack_snapshots(id),
          created_at timestamp with time zone NOT NULL DEFAULT now()
        );
      `);
      await client`INSERT INTO workspaces (id) VALUES (${workspaceId})`;
      await client`INSERT INTO change_records (id, workspace_id, repo, pr_number)
        VALUES (${recordId}, ${workspaceId}, ${repo}, 41)`;
      await client`INSERT INTO acceptance_contracts (id, record_id, version)
        VALUES (${contractId}, ${recordId}, 1)`;
      await client`INSERT INTO acceptance_context_pack_snapshots (
        id, workspace_id, record_id, review_job_id, expected_head_sha,
        acceptance_contract_id, acceptance_contract_version, acceptance_contract_sha256
      ) VALUES (
        ${snapshotId}, ${workspaceId}, ${recordId}, ${cycleId}, ${headSha},
        ${contractId}, 1, ${contractSha}
      )`;
      await client`INSERT INTO acceptance_compiled_context_packs (id, workspace_id, source_snapshot_id)
        VALUES (${packId}, ${workspaceId}, ${snapshotId})`;
      await client`INSERT INTO change_record_events (id, record_id, event_key, payload_ref)
        VALUES (${legacyEventId}, ${recordId}, ${legacyEventKey}, ${client.json(legacyPayload)})`;

      await client.unsafe(migration.replaceAll("--> statement-breakpoint", ""));

      const preserved = await client`SELECT payload_ref FROM change_record_events WHERE id = ${legacyEventId}`;
      expect(preserved[0]?.payload_ref).toEqual(legacyPayload);
      expect(await client`SELECT id FROM acceptance_context_pack_regeneration_executions`).toHaveLength(0);
      const snapshot = await client`SELECT generation_status, regeneration_execution_id
        FROM acceptance_context_pack_snapshots WHERE id = ${snapshotId}`;
      expect(snapshot[0]).toMatchObject({ generation_status: "active", regeneration_execution_id: null });

      const requestIntentId = randomUUID();
      const v3EventKey = `context-pack-regeneration:${packId}:${requestIntentId}`;
      await client`INSERT INTO change_record_events (id, record_id, event_key, payload_ref)
        VALUES (${v3EventId}, ${recordId}, ${v3EventKey}, ${client.json({
          ...legacyPayload,
          version: 3,
          requestIntentId,
          executionId,
        })})`;
      await client`INSERT INTO acceptance_context_pack_regeneration_executions (
        id, workspace_id, record_id, request_event_id, request_event_key,
        source_snapshot_id, prior_compiled_pack_id, repo, pr_number, head_sha,
        head_cycle_id, authority_generation, acceptance_contract_id,
        acceptance_contract_version, acceptance_contract_sha256, reason
      ) VALUES (
        ${executionId}, ${workspaceId}, ${recordId}, ${v3EventId}, ${v3EventKey},
        ${snapshotId}, ${packId}, ${repo}, 41, ${headSha}, ${cycleId}, 1,
        ${contractId}, 1, ${contractSha}, 'stale'
      )`;
      expect(await client`SELECT id FROM acceptance_context_pack_regeneration_executions
        WHERE id = ${executionId}`).toHaveLength(1);
    } finally {
      await client.unsafe("SET search_path TO public").catch(() => undefined);
      await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  }, 30_000);
});
