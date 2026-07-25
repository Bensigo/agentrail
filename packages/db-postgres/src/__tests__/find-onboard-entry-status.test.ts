import { beforeEach, describe, expect, it, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free and
// `findOnboardEntryStatus` never touches a real Postgres. It makes exactly one
// db call: db.select({...}).from().where(cond) → rows. Mirrors the plain
// select().from().where() mock shape `onboard-freshness.test.ts` and
// `onboard-intake.test.ts` already establish in this package (this query has no
// join, so it is simpler than `onboard-freshness.test.ts`'s own chain).
const mockState = vi.hoisted(() => ({
  rows: [] as Array<{ state: string; updatedAt: Date }>,
  capturedWhere: undefined as unknown,
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (cond: unknown) => {
          mockState.capturedWhere = cond;
          return mockState.rows;
        },
      }),
    }),
  },
}));

import { findOnboardEntryStatus } from "../queries/github_intake.js";

describe("findOnboardEntryStatus — read-only onboard-row lookup (push min-interval guard)", () => {
  beforeEach(() => {
    mockState.rows = [];
    mockState.capturedWhere = undefined;
  });

  it("returns { state, updatedAt } when the repo's onboard row exists", async () => {
    const updatedAt = new Date("2026-07-24T12:00:00.000Z");
    mockState.rows = [{ state: "green", updatedAt }];

    const result = await findOnboardEntryStatus("ws-1", "acme/widgets");

    expect(result).toEqual({ state: "green", updatedAt });
    expect(mockState.capturedWhere).toBeDefined();
  });

  it("returns null when the repo has never been onboarded", async () => {
    mockState.rows = [];

    const result = await findOnboardEntryStatus("ws-1", "acme/never-connected");

    expect(result).toBeNull();
  });
});
