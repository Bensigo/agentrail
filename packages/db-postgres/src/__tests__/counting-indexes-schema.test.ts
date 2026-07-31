import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(__dirname, "../../drizzle/migrations/0061_counting_indexes.sql");

describe("0061 counting indexes", () => {
  it("creates both counting indexes idempotently", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS chat_identities_user_id_idx");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS channel_inbox_workspace_created_idx");
  });
  it("is registered in the journal (unjournaled migrations are silently skipped)", () => {
    const journal = JSON.parse(
      readFileSync(join(__dirname, "../../drizzle/migrations/meta/_journal.json"), "utf8")
    );
    expect(journal.entries.some((e: { tag: string }) => e.tag === "0061_counting_indexes")).toBe(true);
  });
});
