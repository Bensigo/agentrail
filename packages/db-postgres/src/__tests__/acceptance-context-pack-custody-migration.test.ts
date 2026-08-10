import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../drizzle/migrations/0086_acceptance_context_pack_custody.sql", import.meta.url);
const journalUrl = new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url);

describe("0086 acceptance Context Pack custody migration", () => {
  it("is registered directly after 0085 and upgrades existing snapshots without compiler schema", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(fileURLToPath(migrationUrl), "utf8"),
      readFile(fileURLToPath(journalUrl), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };
    const admission = journal.entries.find((entry) => entry.tag === "0085_acceptance_context_pack_snapshots");
    const custody = journal.entries.find((entry) => entry.tag === "0086_acceptance_context_pack_custody");

    expect(admission).toMatchObject({ idx: 90 });
    expect(custody).toMatchObject({ idx: 91 });
    expect(migration).toContain('ALTER TABLE "acceptance_context_pack_snapshots"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "acceptance_contract_sha256" text');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "correction_packet_payload_set_sha256" text');
    expect(migration).not.toContain('acceptance_compiled_context_packs');
    expect(migration).not.toContain("SET NOT NULL");
  });
});
