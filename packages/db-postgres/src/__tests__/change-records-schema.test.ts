import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceContracts,
  acceptanceContextPackCompilations,
  acceptanceContextPackDeliveries,
  acceptanceContextPacks,
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

  it("stores metadata-only Context Pack versions and delivery audit rows", () => {
    expect(acceptanceContextPacks.recordId.notNull).toBe(true);
    expect(acceptanceContextPacks.version.notNull).toBe(true);
    expect(acceptanceContextPacks.contentHash.notNull).toBe(true);
    expect(acceptanceContextPacks.manifest.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPacks.custody.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPacks.freshness.getSQLType()).toBe("jsonb");
    expect(acceptanceContextPackDeliveries.contextPackId.notNull).toBe(true);
    expect(acceptanceContextPackDeliveries.deliveryKey.notNull).toBe(true);
    expect(acceptanceContextPackDeliveries.metadata.getSQLType()).toBe("jsonb");
  });

  it("binds a compiler job to one repository ref and confirmed-contract version without source content", () => {
    expect(acceptanceContextPackCompilations.recordId.notNull).toBe(true);
    expect(acceptanceContextPackCompilations.repositoryId.notNull).toBe(true);
    expect(acceptanceContextPackCompilations.repositoryRef.notNull).toBe(true);
    expect(acceptanceContextPackCompilations.acceptanceContractId.notNull).toBe(true);
    expect(acceptanceContextPackCompilations.acceptanceContractVersion.notNull).toBe(true);
    expect(acceptanceContextPackCompilations.status.hasDefault).toBe(true);
    const config = getTableConfig(acceptanceContextPackCompilations);
    expect(config.indexes.find((i) => i.config.name === "acceptance_context_pack_compilations_binding_key")).toBeDefined();
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

describe("0082_acceptance_context_packs migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0082_acceptance_context_packs.sql"
  );

  it("creates metadata-only pack and delivery tables", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_packs"');
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_pack_deliveries"');
    expect(sqlText).toContain('"manifest" jsonb NOT NULL');
    expect(sqlText).toContain('"metadata" jsonb DEFAULT \'{}\'::jsonb NOT NULL');
    expect(sqlText).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_packs_record_content_hash_key"');
    expect(sqlText).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_deliveries_pack_key"');
  });

  it("is registered in the journal", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0082_acceptance_context_packs"
    );
    expect(entry).toMatchObject({ idx: 87, version: "7", breakpoints: true });
  });
});

describe("0093_acceptance_context_pack_compilations migration", () => {
  const MIGRATION = join(__dirname, "../../drizzle/migrations/0093_acceptance_context_pack_compilations.sql");

  it("creates a branch-bound worker queue with an explicit non-source result lifecycle", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_pack_compilations"');
    expect(sqlText).toContain('"repository_ref" text NOT NULL');
    expect(sqlText).toContain("'compiled', 'not_proven', 'failed'");
    expect(sqlText).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_compilations_binding_key"');
  });

  it("is registered in the migration journal", () => {
    const journal = JSON.parse(readFileSync(join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"));
    const entry = journal.entries.find((e: { tag: string }) => e.tag === "0093_acceptance_context_pack_compilations");
    expect(entry).toMatchObject({ idx: 98, version: "7", breakpoints: true });
  });
});

describe("0094_evidence_verification_api_artifacts migration", () => {
  const MIGRATION = join(__dirname, "../../drizzle/migrations/0094_evidence_verification_api_artifacts.sql");

  it("allows inspectable redacted JSON API proof artifacts", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('DROP CONSTRAINT IF EXISTS "evidence_verification_artifacts_content_type_check"');
    expect(sqlText).toContain("'application/json'");
  });

  it("is registered in the migration journal", () => {
    const journal = JSON.parse(readFileSync(join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8"));
    const entry = journal.entries.find((e: { tag: string }) => e.tag === "0094_evidence_verification_api_artifacts");
    expect(entry).toMatchObject({ idx: 99, version: "7", breakpoints: true });
  });
});
