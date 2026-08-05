import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runs } from "../schema/runs.js";

describe("runs published-head provenance (#1630)", () => {
  it("keeps the produced PR head nullable so legacy run rows remain unknown", () => {
    expect(runs.prHeadSha.notNull).toBe(false);
    expect(runs.prHeadSha.getSQLType()).toBe("text");
  });

  it("ships the additive column in a registered migration", () => {
    const migration = join(
      __dirname,
      "../../drizzle/migrations/0078_runs_pr_head_sha.sql"
    );
    expect(readFileSync(migration, "utf8")).toContain(
      'ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "pr_head_sha" text;'
    );

    const journal = JSON.parse(
      readFileSync(
        join(__dirname, "../../drizzle/migrations/meta/_journal.json"),
        "utf8"
      )
    );
    expect(
      journal.entries.find(
        (entry: { tag: string }) => entry.tag === "0078_runs_pr_head_sha"
      )
    ).toMatchObject({ idx: 83, version: "7", breakpoints: true });
  });
});
