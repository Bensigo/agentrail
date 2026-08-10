import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceBuilderRoutes,
  acceptanceCompiledContextPacks,
  acceptanceContextPackSnapshots,
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
} from "../schema/change_records.js";

describe("change_records schema — declarations (Arc D storage)", () => {
  it("uses caller-supplied deterministic ids for records and events", () => {
    expect(changeRecords.id.hasDefault).toBe(false);
    expect(changeRecordEvents.id.hasDefault).toBe(false);
  });

  it("declares nullable issue/pr anchors and default-open state", () => {
    expect(changeRecords.issueNumber.notNull).toBe(false);
    expect(changeRecords.prNumber.notNull).toBe(false);
    expect(changeRecords.state.notNull).toBe(true);
    expect(changeRecords.state.hasDefault).toBe(true);
  });

  it("keeps head_shas as a non-null text array with a default", () => {
    expect(changeRecords.headShas.notNull).toBe(true);
    expect(changeRecords.headShas.hasDefault).toBe(true);
    expect(changeRecords.headShas.getSQLType()).toBe("text[]");
  });

  it("declares event payload refs as non-null jsonb", () => {
    expect(changeRecordEvents.payloadRef.notNull).toBe(true);
    expect(changeRecordEvents.payloadRef.getSQLType()).toBe("jsonb");
  });

  it("declares the unique issue and PR lookup keys", () => {
    const config = getTableConfig(changeRecords);
    expect(
      config.indexes.find((i) => i.config.name === "change_records_issue_key")
    ).toBeDefined();
    expect(
      config.indexes.find((i) => i.config.name === "change_records_pr_key")
    ).toBeDefined();
  });

  it("declares the per-record event idempotency key", () => {
    const config = getTableConfig(changeRecordEvents);
    const idx = config.indexes.find(
      (i) => i.config.name === "change_record_events_record_event_key"
    );
    expect(idx).toBeDefined();
    const columnNames = idx!.config.columns.map(
      (c) => (c as { name?: string }).name
    );
    expect(columnNames).toEqual(["record_id", "event_key"]);
  });

  it("declares versioned Acceptance Contracts with explicit draft/confirmed state", () => {
    expect(acceptanceContracts.recordId.notNull).toBe(true);
    expect(acceptanceContracts.version.notNull).toBe(true);
    expect(acceptanceContracts.status.notNull).toBe(true);
    expect(acceptanceContracts.status.hasDefault).toBe(true);
    expect(acceptanceContracts.contract.notNull).toBe(true);
    expect(acceptanceContracts.contract.getSQLType()).toBe("jsonb");
    expect(acceptanceContracts.confirmedBy.notNull).toBe(false);
    expect(acceptanceContracts.confirmedAt.notNull).toBe(false);
  });

  it("gives a manual Acceptance Record a durable work key before issue or PR anchors exist", () => {
    expect(changeRecords.workKey.notNull).toBe(false);
  });
});

describe("0070_change_records migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0070_change_records.sql"
  );

  it("creates both tables idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "change_records"');
    expect(sqlText).toContain(
      'CREATE TABLE IF NOT EXISTS "change_record_events"'
    );
  });

  it("guards both foreign keys against re-run duplicate_object errors", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      "change_records_workspace_id_workspaces_id_fk"
    );
    expect(sqlText).toContain(
      "change_record_events_record_id_change_records_id_fk"
    );
    expect(sqlText).toContain("WHEN duplicate_object THEN null");
  });

  it("creates the issue, PR, idempotency, and timeline indexes idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "change_records_issue_key"'
    );
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "change_records_pr_key"'
    );
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "change_record_events_record_event_key"'
    );
    expect(sqlText).toContain(
      'CREATE INDEX IF NOT EXISTS "change_record_events_timeline_idx"'
    );
  });

  it("is registered in the journal at idx 74", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0070_change_records"
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(74);
    expect(entry.version).toBe("7");
    expect(entry.breakpoints).toBe(true);
  });
});

describe("0081_acceptance_contracts migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0081_acceptance_contracts.sql"
  );

  it("adds manual intake identity and creates immutable contract versions", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS "work_key"');
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS "origin_channel"');
    expect(sqlText).toContain('ADD COLUMN IF NOT EXISTS "source_references"');
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_contracts"');
    expect(sqlText).toContain('"contract" jsonb NOT NULL');
  });

  it("prevents duplicate contract versions and multiple confirmed contracts", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_contracts_record_version_key"'
    );
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_contracts_one_confirmed_per_record"'
    );
  });

  it("is registered in the journal", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0081_acceptance_contracts"
    );
    expect(entry).toMatchObject({ idx: 86, version: "7", breakpoints: true });
  });
});

describe("0084_acceptance_builder_routes migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0084_acceptance_builder_routes.sql"
  );

  it("declares a workspace/repository-scoped server route registry", () => {
    expect(acceptanceBuilderRoutes.workspaceId.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.repo.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.adapter.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.configurationVersion.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.registeredBy.notNull).toBe(true);
    expect(acceptanceBuilderRoutes.status.hasDefault).toBe(true);
    const config = getTableConfig(acceptanceBuilderRoutes);
    expect(config.indexes.find((index) =>
      index.config.name === "acceptance_builder_routes_workspace_repo_status_idx"
    )).toBeDefined();
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "acceptance_builder_routes_adapter_check",
      "acceptance_builder_routes_configuration_version_check",
      "acceptance_builder_routes_registered_by_check",
      "acceptance_builder_routes_repo_check",
      "acceptance_builder_routes_status_check",
    ]);
  });

  it("constrains adapters, status, configuration version, actor, and repository", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    for (const adapter of [
      "github_codex", "github_claude", "durable_github_fallback", "durable_jace_fallback",
    ]) expect(sqlText).toContain(`'${adapter}'`);
    expect(sqlText).not.toContain("codex_app_server");
    expect(sqlText).not.toContain("mcp_correction_inbox");
    expect(sqlText).toContain("acceptance_builder_routes_status_check");
    expect(sqlText).toContain("acceptance_builder_routes_configuration_version_check");
    expect(sqlText).toContain("acceptance_builder_routes_registered_by_check");
    expect(sqlText).toContain("acceptance_builder_routes_repo_check");
  });

  it("is registered in the migration journal", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0084_acceptance_builder_routes"
    )).toMatchObject({ idx: 89, version: "7", breakpoints: true });
  });
});

describe("0085_acceptance_context_pack_snapshots migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0085_acceptance_context_pack_snapshots.sql"
  );

  it("declares immutable exact-head snapshot anchors and metadata-only provenance", () => {
    expect(acceptanceContextPackSnapshots.workspaceId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.recordId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.reviewJobId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.acceptanceContractId.notNull).toBe(true);
    expect(acceptanceContextPackSnapshots.baseSha.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.mergeBaseSha.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.headTreeSha.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.baseIndex.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.overlay.notNull).toBe(false);
    expect(acceptanceContextPackSnapshots.baseIndex.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPackSnapshots.overlay.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPackSnapshots.provenance.getSQLType()).toBe("jsonb");
  });

  it("makes replay identity unique and limits status to snapshot custody states", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_pack_snapshots"');
    expect(sqlText).toContain('"status" IN (\'admitted\', \'not_proven\')');
    expect(sqlText).toContain("acceptance_context_pack_snapshots_reason_check");
    expect(sqlText).toContain("acceptance_context_pack_snapshots_identity_json_check");
    expect(sqlText).toContain('"acceptance_context_pack_snapshots_replay_key"');
    expect(sqlText).toContain('"acceptance_context_pack_snapshots_review_job_idx"');
  });
});

describe("0087_acceptance_compiled_context_packs migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0087_acceptance_compiled_context_packs.sql"
  );

  it("declares an immutable metadata-only Pack row with workspace-scoped replay", () => {
    expect(acceptanceCompiledContextPacks.workspaceId.notNull).toBe(true);
    expect(acceptanceCompiledContextPacks.sourceSnapshotId.notNull).toBe(true);
    expect(acceptanceCompiledContextPacks.binding.getSQLType()).toBe("jsonb");
    expect(acceptanceCompiledContextPacks.manifest.getSQLType()).toBe("jsonb");
    expect(acceptanceCompiledContextPacks.sourceCustodyReceipt.getSQLType()).toBe("jsonb");
    expect(acceptanceCompiledContextPacks.exactHeadDependencyTreeProofs.getSQLType()).toBe("jsonb");
    const config = getTableConfig(acceptanceCompiledContextPacks);
    expect(config.indexes.find((index) =>
      index.config.name === "acceptance_compiled_context_packs_replay_key"
    )).toBeDefined();
  });

  it("is registered after the nullable 0086 custody upgrade", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"
    ));
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_compiled_context_packs"');
    expect(sqlText).toContain('"source_snapshot_id" uuid NOT NULL REFERENCES "acceptance_context_pack_snapshots"("id") ON DELETE restrict');
    expect(sqlText).not.toContain("rendered_json");
    expect(sqlText).not.toContain("source_text");
    expect(sqlText).toContain('"exact_head_dependency_tree_proofs" jsonb NOT NULL');
    expect(journal.entries.find(
      (entry: { tag: string }) => entry.tag === "0087_acceptance_compiled_context_packs"
    )).toMatchObject({ idx: 92, version: "7", breakpoints: true });
  });
});
