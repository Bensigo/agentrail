import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("0105 dependency observation claim migration", () => {
  it("appends opaque, bounded claims after exact-Pack delivery custody", async () => {
    const [migration, journalText] = await Promise.all([
      readFile(fileURLToPath(new URL(
        "../../drizzle/migrations/0105_acceptance_dependency_observation_claims.sql",
        import.meta.url,
      )), "utf8"),
      readFile(fileURLToPath(new URL("../../drizzle/migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ]);
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries).toContainEqual(expect.objectContaining({
      idx: 110,
      tag: "0105_acceptance_dependency_observation_claims",
    }));
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "acceptance_dependency_observation_claims"');
    expect(migration).toContain('"claim_token_sha256" text NOT NULL');
    expect(migration).toContain('"github_installation_identity_sha256" text NOT NULL');
    expect(migration).toContain('"lease_expires_at" > "claimed_at"');
    expect(migration).toContain('(("consumed_at" IS NULL) = ("observation_event_id" IS NULL))');
    expect(migration).not.toMatch(/github_token|installation_token|access_token/u);
  });
});
