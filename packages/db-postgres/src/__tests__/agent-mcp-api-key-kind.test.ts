import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { apiKeys } from "../schema/api_keys.js";

describe("agent_mcp API-key kind", () => {
  const migrationPath = join(
    __dirname,
    "../../drizzle/migrations/0101_agent_mcp_api_key_kind.sql",
  );

  it("admits the dedicated kind in schema and migration without changing old defaults", () => {
    expect(apiKeys.kind.default).toBe("self_hosted");
    expect(getTableConfig(apiKeys).checks.map((entry) => entry.name))
      .toContain("api_keys_kind_check");
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("'self_hosted', 'fleet', 'agent_mcp'");
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "api_keys_kind_check"');
  });

  it("registers directly after the current 0100 migration", () => {
    const journal = JSON.parse(readFileSync(
      join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
      "utf8",
    ));
    const index = journal.entries.findIndex(
      (entry: { tag: string }) => entry.tag === "0101_agent_mcp_api_key_kind",
    );
    expect(journal.entries[index]).toMatchObject({ idx: 106, version: "7", breakpoints: true });
    expect(journal.entries[index - 1]?.tag).toBe("0100_acceptance_brief_bindings");
  });
});
