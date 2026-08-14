import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("0104 Context Pack regeneration executions migration", () => {
  it("is journaled and enforces queue, exact binding, lease, and replacement custody", async () => {
    const [sql, journalText] = await Promise.all([
      readFile(fileURLToPath(new URL("../../drizzle/migrations/0104_acceptance_context_pack_regeneration_executions.sql", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries).toContainEqual(expect.objectContaining({ idx: 106, tag: "0104_acceptance_context_pack_regeneration_executions" }));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "acceptance_context_pack_regeneration_executions"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "acceptance_context_pack_regeneration_executions_request_key"');
    expect(sql).toContain('"replacement_compiled_pack_id" uuid REFERENCES "acceptance_compiled_context_packs"');
    expect(sql).toContain('"lease_token_sha256" IS NOT NULL');
    expect(sql).toContain('"status" = \'replaced\'');
  });
});
