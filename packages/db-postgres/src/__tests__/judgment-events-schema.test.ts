import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JUDGMENT_EVENT_TYPES,
  judgmentEvents,
} from "../schema/judgment_events.js";

describe("judgment_events schema — declarations (Arc E storage)", () => {
  it("uses caller-supplied deterministic ids", () => {
    expect(judgmentEvents.id.hasDefault).toBe(false);
  });

  it("declares the approved Arc E event categories", () => {
    expect(JUDGMENT_EVENT_TYPES).toEqual([
      "review_outcome",
      "requirement_correction",
      "rejected_approach",
      "false_green",
      "missed_check",
    ]);
    expect(judgmentEvents.type.notNull).toBe(true);
  });

  it("keeps refs, payload, actor_ref, and source_ref as non-null jsonb", () => {
    expect(judgmentEvents.refs.notNull).toBe(true);
    expect(judgmentEvents.refs.getSQLType()).toBe("jsonb");
    expect(judgmentEvents.payload.notNull).toBe(true);
    expect(judgmentEvents.payload.getSQLType()).toBe("jsonb");
    expect(judgmentEvents.actorRef.notNull).toBe(true);
    expect(judgmentEvents.actorRef.getSQLType()).toBe("jsonb");
    expect(judgmentEvents.sourceRef.notNull).toBe(true);
    expect(judgmentEvents.sourceRef.getSQLType()).toBe("jsonb");
  });

  it("declares the workspace/repo idempotency and read indexes", () => {
    const config = getTableConfig(judgmentEvents);
    const unique = config.indexes.find(
      (i) => i.config.name === "judgment_events_workspace_repo_event_key"
    );
    expect(unique).toBeDefined();
    expect(
      unique!.config.columns.map((c) => (c as { name?: string }).name)
    ).toEqual(["workspace_id", "repo", "event_key"]);
    expect(
      config.indexes.find(
        (i) => i.config.name === "judgment_events_workspace_repo_occurred_idx"
      )
    ).toBeDefined();
    expect(
      config.indexes.find(
        (i) => i.config.name === "judgment_events_workspace_repo_type_idx"
      )
    ).toBeDefined();
  });
});

describe("0071_judgment_events migration", () => {
  const MIGRATION = join(
    __dirname,
    "../../drizzle/migrations/0071_judgment_events.sql"
  );

  it("creates the table idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain('CREATE TABLE IF NOT EXISTS "judgment_events"');
  });

  it("constrains the approved judgment event categories", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    for (const type of JUDGMENT_EVENT_TYPES) {
      expect(sqlText).toContain(`'${type}'`);
    }
    expect(sqlText).toContain("judgment_events_type_check");
  });

  it("guards the workspace foreign key against re-run duplicate_object errors", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain("judgment_events_workspace_id_workspaces_id_fk");
    expect(sqlText).toContain("WHEN duplicate_object THEN null");
  });

  it("creates idempotency and tenant read indexes idempotently", () => {
    const sqlText = readFileSync(MIGRATION, "utf8");
    expect(sqlText).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "judgment_events_workspace_repo_event_key"'
    );
    expect(sqlText).toContain(
      'CREATE INDEX IF NOT EXISTS "judgment_events_workspace_repo_occurred_idx"'
    );
    expect(sqlText).toContain(
      'CREATE INDEX IF NOT EXISTS "judgment_events_workspace_repo_type_idx"'
    );
  });

  it("is registered in the journal at idx 75", () => {
    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0071_judgment_events"
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(75);
    expect(entry.version).toBe("7");
    expect(entry.breakpoints).toBe(true);
  });
});
