import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from "../db.js";
import { getRunnerRunStats } from "../queries/index.js";

const mockDb = vi.mocked(db);

function sqlText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const maybeValue = (value as { value?: unknown }).value;
  if (Array.isArray(maybeValue)) {
    return maybeValue.map(sqlText).join("");
  }
  const queryChunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    return queryChunks.map(sqlText).join("");
  }
  return "";
}

describe("getRunnerRunStats", () => {
  beforeEach(() => {
    mockDb.execute = vi.fn(async () => []) as unknown as typeof db.execute;
  });

  it("uses runner_name with agent fallback for runner identity", async () => {
    await getRunnerRunStats("workspace-1");

    const execute = mockDb.execute as unknown as ReturnType<typeof vi.fn>;
    const query = sqlText(execute.mock.calls[0][0]);

    expect(query).toContain("LOWER(COALESCE(NULLIF(r.runner_name, ''), NULLIF(r.agent, '')))");
    expect(query).toContain("COALESCE(NULLIF(r.runner_name, ''), NULLIF(r.agent, '')) IS NOT NULL");
    expect(query).toContain("GROUP BY LOWER(COALESCE(NULLIF(r.runner_name, ''), NULLIF(r.agent, '')))");
  });
});
