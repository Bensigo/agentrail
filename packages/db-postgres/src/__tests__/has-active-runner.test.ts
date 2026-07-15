import { beforeEach, describe, expect, it, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free and
// `hasActiveRunner` never touches a real Postgres. It makes exactly one db call:
//   select → db.select().from().where().limit() → rows
// `.limit()` captures its argument for assertions and resolves to a configurable
// array so a suite can drive both the "an active key exists" (non-empty) and the
// "no active key" (empty) branches.
//
// vi.mock is hoisted above the file body, so the factory may not close over a
// top-level `let`. `vi.hoisted` gives us a mutable holder that IS hoisted with the
// mock, so the factory and the test body share the same object (mirrors the
// sibling onboard-intake test).
const mockState = vi.hoisted(() => ({
  // The array `.limit()` resolves to; each test sets it before calling.
  rows: [] as Array<{ id: string }>,
  // The argument passed to `.limit()` — captured for assertions.
  capturedLimit: undefined as number | undefined,
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => {
            mockState.capturedLimit = n;
            return mockState.rows;
          },
        }),
      }),
    }),
  },
}));

import { hasActiveRunner } from "../queries/index.js";

describe("hasActiveRunner — recent non-revoked key = a runner is here", () => {
  beforeEach(() => {
    mockState.rows = [];
    mockState.capturedLimit = undefined;
  });

  it("returns true when a matching active key row exists", async () => {
    mockState.rows = [{ id: "k1" }]; // a live, non-revoked, recently-used key

    const result = await hasActiveRunner("ws-1");

    expect(result).toBe(true);
  });

  it("returns false when no matching key row exists", async () => {
    mockState.rows = []; // no recent, non-revoked key

    const result = await hasActiveRunner("ws-1");

    expect(result).toBe(false);
  });

  it("caps the probe at one row (limit 1)", async () => {
    mockState.rows = [{ id: "k1" }];

    await hasActiveRunner("ws-1");

    expect(mockState.capturedLimit).toBe(1);
  });
});
