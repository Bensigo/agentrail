import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
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
