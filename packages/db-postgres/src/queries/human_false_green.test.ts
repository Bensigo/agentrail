import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({ responses: [] as unknown[][], queries: [] as unknown[] }));

vi.mock("../db.js", () => ({
  db: {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn((query: unknown) => {
        state.queries.push(query);
        return Promise.resolve(state.responses.shift() ?? []);
      });
      return chain;
    },
  },
}));

import { getProductionHumanFalseGreen } from "./human_false_green.js";

const dialect = new PgDialect();
const WS = "ws-1";
const HEAD = "a".repeat(40);
const input = {
  workspaceId: WS,
  from: new Date("2026-08-01T00:00:00Z"),
  to: new Date("2026-08-02T00:00:00Z"),
  observedUntil: new Date("2026-08-03T00:00:00Z"),
};

beforeEach(() => {
  state.responses = [];
  state.queries = [];
});

describe("getProductionHumanFalseGreen", () => {
  it("reads successful completed runs and explicit review submissions in the same workspace", async () => {
    state.responses = [
      [
        {
          id: "run-1",
          workspaceId: WS,
          status: "success",
          finishedAt: new Date("2026-08-01T10:00:00Z"),
          prUrl: "https://github.com/acme/widgets/pull/42",
          prHeadSha: HEAD,
        },
      ],
      [
        {
          id: "event-1",
          workspaceId: WS,
          repo: "acme/widgets",
          prNumber: 42,
          taskFamily: null,
          deliveryId: "delivery-1",
          eventType: "review_submitted",
          occurredAt: new Date("2026-08-01T11:00:00Z"),
          headSha: HEAD,
          reviewState: "CHANGES_REQUESTED",
          actorType: "human",
          additions: null,
          deletions: null,
          changedFiles: null,
          humanReviewMinutes: null,
          humanReviewSource: null,
          createdAt: new Date("2026-08-01T11:00:00Z"),
        },
      ],
    ];

    await expect(getProductionHumanFalseGreen(input)).resolves.toMatchObject({
      knownSampleSize: 1,
      falseGreenCount: 1,
    });
    expect(state.queries).toHaveLength(2);
    const queries = state.queries.map((query) => dialect.sqlToQuery(query as never).sql);
    expect(queries[0]).toContain('"runs"."status" = $2');
    expect(queries[0]).toContain('"runs"."finished_at" >= $3');
    expect(queries[1]).toContain('"review_events"."event_type" = $2');
    expect(queries[1]).toContain('"review_events"."occurred_at" <= $3');
  });
});
