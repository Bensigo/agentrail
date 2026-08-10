import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../drizzle/migrations/0087_acceptance_compiled_context_packs.sql", import.meta.url);
const journalUrl = new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url);

describe("0087 compiled Context Pack migration", () => {
  it("starts after 0086 without mutating legacy snapshot custody rows", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(fileURLToPath(migrationUrl), "utf8"),
      readFile(fileURLToPath(journalUrl), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((entry) => entry.tag === "0086_acceptance_context_pack_custody")).toMatchObject({ idx: 91 });
    expect(journal.entries.find((entry) => entry.tag === "0087_acceptance_compiled_context_packs")).toMatchObject({ idx: 92 });
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "acceptance_compiled_context_packs"');
    expect(migration).toContain('"exact_head_dependency_tree_proofs" jsonb NOT NULL');
    expect(migration).not.toContain('ALTER TABLE "acceptance_context_pack_snapshots"');
  });
});
