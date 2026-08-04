import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ alignmentBriefId: string | null }>,
  where: undefined as unknown,
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = (condition: unknown) => {
        state.where = condition;
        return chain;
      };
      chain.limit = async () => state.rows;
      return chain;
    },
  },
}));

import { getQueueEntryBriefReference } from "../queries/index.js";

describe("getQueueEntryBriefReference", () => {
  it("scopes the durable brief lookup by workspace and queue entry id", async () => {
    state.rows = [{ alignmentBriefId: "brief-in-workspace-a" }];

    await expect(
      getQueueEntryBriefReference("workspace-a", "queue-entry-1")
    ).resolves.toEqual({ alignmentBriefId: "brief-in-workspace-a" });

    const { sql, params } = new PgDialect().sqlToQuery(state.where as never);
    expect(sql).toContain('"queue_entries"."workspace_id"');
    expect(sql).toContain('"queue_entries"."id"');
    expect(params).toEqual(["workspace-a", "queue-entry-1"]);
  });

  it("returns null when no row exists in the requested workspace", async () => {
    state.rows = [];
    await expect(
      getQueueEntryBriefReference("workspace-b", "queue-entry-1")
    ).resolves.toBeNull();
  });
});
