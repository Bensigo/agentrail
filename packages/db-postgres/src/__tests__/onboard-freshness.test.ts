import { beforeEach, describe, expect, it, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free and
// `getLatestOnboardMemoryAt` never touches a real Postgres. It makes exactly one
// db call:
//   db.select({...}).from().innerJoin().where(cond) → rows
// The chain resolves at `.where()` to a configurable array so a suite can drive
// both the "onboarded" (one aggregate row) and the "never onboarded" (max=null,
// count=0) branches. `capturedWhere` records the final where() argument so the
// filter can be asserted. `vi.hoisted` gives a mutable holder that is hoisted
// alongside the mock factory (mirrors onboard-intake.test.ts).
const mockState = vi.hoisted(() => ({
  // The array `.where()` resolves to; each test sets it before calling.
  rows: [] as Array<{ onboardedAt: Date | null; count: number }>,
  // The condition passed to the final `.where()` — captured for assertions.
  capturedWhere: undefined as unknown,
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async (cond: unknown) => {
            mockState.capturedWhere = cond;
            return mockState.rows;
          },
        }),
      }),
    }),
  },
}));

import { getLatestOnboardMemoryAt } from "../queries/index.js";

describe("getLatestOnboardMemoryAt — onboarding recency for the runner", () => {
  beforeEach(() => {
    mockState.rows = [];
    mockState.capturedWhere = undefined;
  });

  it("returns the mocked max timestamp and count when notes exist", async () => {
    const onboardedAt = new Date("2026-07-15T12:34:56.000Z");
    mockState.rows = [{ onboardedAt, count: 7 }];

    const result = await getLatestOnboardMemoryAt("ws-1", "acme/widgets");

    expect(result).toEqual({ onboardedAt, count: 7 });
    // The query issued a filter (workspace + repo + written_by=onboarder).
    expect(mockState.capturedWhere).toBeDefined();
  });

  it("returns { onboardedAt: null, count: 0 } when the aggregate row is empty", async () => {
    // Postgres returns one aggregate row with max=NULL / count=0 when nothing
    // matches (repo never onboarded, or repo row absent).
    mockState.rows = [{ onboardedAt: null, count: 0 }];

    const result = await getLatestOnboardMemoryAt("ws-1", "acme/never-seen");

    expect(result).toEqual({ onboardedAt: null, count: 0 });
  });

  it("returns { onboardedAt: null, count: 0 } when no row comes back at all", async () => {
    mockState.rows = [];

    const result = await getLatestOnboardMemoryAt("ws-1", "acme/widgets");

    expect(result).toEqual({ onboardedAt: null, count: 0 });
  });

  it("coerces a string count from the driver to a number", async () => {
    // node-postgres can surface COUNT(*) as a string; the query normalizes it.
    mockState.rows = [
      { onboardedAt: new Date("2026-01-01T00:00:00.000Z"), count: "3" as unknown as number },
    ];

    const result = await getLatestOnboardMemoryAt("ws-1", "acme/widgets");

    expect(result.count).toBe(3);
    expect(typeof result.count).toBe("number");
  });
});
