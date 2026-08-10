import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { changeRecords } from "../schema/change_records.js";

const migrationUrl = new URL(
  "../../drizzle/migrations/0088_change_records_current_pr_head.sql",
  import.meta.url
);
const journalUrl = new URL(
  "../../drizzle/migrations/meta/_journal.json",
  import.meta.url
);
const generationMigrationUrl = new URL(
  "../../drizzle/migrations/0089_change_records_pr_head_authority_generation.sql",
  import.meta.url
);

describe("0088 current Acceptance Record PR head migration", () => {
  it("declares one nullable current-head pointer without rewriting immutable history", () => {
    expect(changeRecords.currentPrHeadSha.notNull).toBe(false);
    expect(changeRecords.currentPrHeadSha.getSQLType()).toBe("text");
    expect(changeRecords.currentPrHeadCycleId.notNull).toBe(false);
    expect(changeRecords.currentPrHeadCycleId.getSQLType()).toBe("uuid");
    expect(changeRecords.currentPrHeadAuthoritative.notNull).toBe(true);
    expect(changeRecords.currentPrHeadAuthoritative.hasDefault).toBe(true);
    expect(getTableConfig(changeRecords).checks.find(
      (constraint) => constraint.name === "change_records_current_pr_head_history_check"
    )).toBeDefined();
  });

  it("adds the pointer and fail-closes active legacy jobs without guessing from head history", async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), "utf8");

    expect(migration).toContain(
      'ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "current_pr_head_sha" text'
    );
    expect(migration).toContain(
      'ALTER TABLE "change_records" ADD COLUMN IF NOT EXISTS "current_pr_head_cycle_id" uuid'
    );
    expect(migration).toContain(
      'ADD COLUMN "current_pr_head_authoritative" boolean NOT NULL DEFAULT false'
    );
    expect(migration).toContain('WHERE "state" IN (\'queued\', \'running\')');
    expect(migration).toContain("SET \"state\" = 'superseded'");
    expect(migration).toContain("SET \"status\" = 'torn_down'");
    expect(migration).toContain(
      "current Acceptance Record cycle unavailable after migration"
    );
    expect(migration).toContain(
      'WHERE "status" IN (\'pending\', \'claimed\', \'booting\', \'ready\')'
    );
    expect(migration).toContain(
      'CONSTRAINT "change_records_current_pr_head_history_check"'
    );
    expect(migration).toContain(
      '"current_pr_head_sha" ~ \'^[A-Fa-f0-9]{40}$\''
    );
    expect(migration).toContain(
      '"current_pr_head_sha" = ANY("head_shas")'
    );
    expect(migration).toContain(
      '("current_pr_head_sha" IS NULL) = ("current_pr_head_cycle_id" IS NULL)'
    );
    expect(migration).toContain(
      '"current_pr_head_sha" IS NOT NULL AND "current_pr_head_cycle_id" IS NOT NULL'
    );
    expect(migration).not.toMatch(/current_pr_head_sha\s*=\s*.*head_shas/i);
    expect(migration).not.toContain('UPDATE "change_records"');
  });

  it("is registered immediately after compiled Context Pack custody", async () => {
    const journal = JSON.parse(
      await readFile(fileURLToPath(journalUrl), "utf8")
    ) as { entries: Array<{ idx: number; tag: string; version: string }> };

    expect(
      journal.entries.find(
        (entry) => entry.tag === "0088_change_records_current_pr_head"
      )
    ).toMatchObject({ idx: 93, version: "7" });
  });
});

describe("0089 current Acceptance Record PR authority generation migration", () => {
  it("declares a nonnegative monotonic authority revision", () => {
    expect(changeRecords.currentPrHeadAuthorityGeneration.notNull).toBe(true);
    expect(changeRecords.currentPrHeadAuthorityGeneration.hasDefault).toBe(true);
    expect(changeRecords.currentPrHeadAuthorityGeneration.getSQLType()).toBe("integer");
  });

  it("adds a fail-closed revision without rewriting existing authority", async () => {
    const migration = await readFile(fileURLToPath(generationMigrationUrl), "utf8");
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "current_pr_head_authority_generation" integer NOT NULL DEFAULT 0'
    );
    expect(migration).toContain(
      'CONSTRAINT "change_records_current_pr_head_authority_generation_check"'
    );
    expect(migration).toContain('"current_pr_head_authority_generation" >= 0');
    expect(migration).not.toContain('UPDATE "change_records"');
  });

  it("is registered immediately after current-head custody", async () => {
    const journal = JSON.parse(
      await readFile(fileURLToPath(journalUrl), "utf8")
    ) as { entries: Array<{ idx: number; tag: string; version: string }> };
    expect(journal.entries.find(
      (entry) => entry.tag === "0089_change_records_pr_head_authority_generation"
    )).toMatchObject({ idx: 94, version: "7" });
  });
});
