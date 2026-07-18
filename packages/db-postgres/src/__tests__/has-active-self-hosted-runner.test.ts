import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// Same mocking shape as has-active-runner.test.ts (the sibling this function
// mirrors): the db module is mocked so importing the query module never
// touches a real Postgres. Unlike that sibling, this suite ALSO captures the
// `.where(...)` argument so the one thing that's actually NEW here — the
// `kind = 'self_hosted'` filter — is asserted structurally (the
// renderCondition/PgDialect.sqlToQuery pattern used across this package),
// not just the rows-in/bool-out behavior.
const mockState = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  capturedWhere: undefined as unknown,
  capturedLimit: undefined as number | undefined,
}));

vi.mock("../db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          mockState.capturedWhere = cond;
          return {
            limit: async (n: number) => {
              mockState.capturedLimit = n;
              return mockState.rows;
            },
          };
        },
      }),
    }),
  },
}));

import { hasActiveSelfHostedRunner } from "../queries/index.js";

const dialect = new PgDialect();
function render(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  mockState.rows = [];
  mockState.capturedWhere = undefined;
  mockState.capturedLimit = undefined;
});

describe("hasActiveSelfHostedRunner — kind='self_hosted'-only presence signal (#1267 PR ①)", () => {
  it("returns true when a matching self_hosted active key row exists", async () => {
    mockState.rows = [{ id: "k1" }];

    const result = await hasActiveSelfHostedRunner("ws-1");

    expect(result).toBe(true);
  });

  it("returns false when no matching key row exists", async () => {
    mockState.rows = [];

    const result = await hasActiveSelfHostedRunner("ws-1");

    expect(result).toBe(false);
  });

  it("caps the probe at one row (limit 1)", async () => {
    mockState.rows = [{ id: "k1" }];

    await hasActiveSelfHostedRunner("ws-1");

    expect(mockState.capturedLimit).toBe(1);
  });

  it("filters on workspace_id, kind = 'self_hosted', and revoked_at IS NULL — the exact narrowing from hasActiveRunner", async () => {
    await hasActiveSelfHostedRunner("ws-1");

    const rendered = render(mockState.capturedWhere);
    expect(rendered.sql).toContain('"workspace_id"');
    expect(rendered.sql).toContain('"kind"');
    expect(rendered.sql).toContain('"revoked_at" is null');
    expect(rendered.sql).toContain('"last_used_at"');
    expect(rendered.params).toContain("ws-1");
    expect(rendered.params).toContain("self_hosted");
  });

  it("computes `since` from the given windowMs (default 1h) as a bound timestamp parameter", async () => {
    const before = Date.now();
    await hasActiveSelfHostedRunner("ws-1", 30 * 60 * 1000); // 30 min window
    const after = Date.now();

    const rendered = render(mockState.capturedWhere);
    // PgDialect.sqlToQuery serializes a Date param to its ISO string, typed
    // "timestamp" in the parallel `typings` array (see hasActiveRunner's own
    // `since` for the identical shape) — locate it by that typing rather than
    // by `instanceof Date`.
    const sinceIndex = rendered.typings?.indexOf("timestamp") ?? -1;
    expect(sinceIndex).toBeGreaterThanOrEqual(0);
    const sinceMs = new Date(rendered.params[sinceIndex] as string).getTime();
    // since = now - windowMs, computed somewhere between `before` and `after`.
    expect(sinceMs).toBeGreaterThanOrEqual(before - 30 * 60 * 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 30 * 60 * 1000);
  });
});
