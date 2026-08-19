import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("0104 dependency Builder delivery migration", () => {
  it("appends one delivery-only lifecycle after Context Pack regeneration", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(fileURLToPath(new URL(
        "../../drizzle/migrations/0104_acceptance_dependency_builder_deliveries.sql",
        import.meta.url,
      )), "utf8"),
      readFile(fileURLToPath(new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries).toContainEqual(expect.objectContaining({
      idx: 109,
      tag: "0104_acceptance_dependency_builder_deliveries",
    }));
    expect(migration).toContain('"status" IN (\'reserved\', \'carrier_accepted\', \'bounded_failed\', \'ambiguous_hold\')');
    expect(migration).not.toMatch(/reentered|successor_head|github_delivery_event/u);
  });
});
