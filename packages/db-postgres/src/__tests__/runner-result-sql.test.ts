import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Guard against SQL ↔ helper drift (the review's required fix for #890 / loop
 * escalation). `nextQueueTransition` is the unit-tested spec, but PRODUCTION runs
 * the hand-written UPDATE inside `recordRunnerResult`. There is no live-DB test
 * harness in this package (every spec mocks `db`), so we mock `db` to CAPTURE the
 * SQL object the function builds and render it with drizzle's PgDialect, then
 * assert the load-bearing fragments — especially the red-vs-error tier behavior,
 * the dimension most likely to silently diverge from the helper.
 */

const captured: unknown[] = [];

vi.mock("../db.js", () => ({
  db: {
    // red/error path: capture the UPDATE; return one row so `updated` is true.
    execute: (q: unknown) => {
      captured.push(q);
      return [{ id: "x" }];
    },
    // tail mirror onto the `runs` row — chainable no-op.
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

import { recordRunnerResult } from "../queries/runner.js";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as never).sql;

beforeEach(() => {
  captured.length = 0;
});

describe("recordRunnerResult SQL (lockstep with nextQueueTransition)", () => {
  it("red spends budget, escalates at exhaustion, and BUMPS tier", async () => {
    const ok = await recordRunnerResult({ id: "1", workspaceId: "w", status: "red" });
    expect(ok).toBe(true);
    const sql = render(captured[0]);
    expect(sql).toContain("escalated-to-human");
    expect(sql).toContain("remaining_budget"); // GREATEST(remaining_budget - 1, 0)
    expect(sql).toContain("remaining_budget <= 1");
    // tier bump for a gate failure
    expect(sql).toContain("LEAST(tier + 1");
  });

  it("error spends budget and escalates, but does NOT bump tier", async () => {
    const ok = await recordRunnerResult({ id: "1", workspaceId: "w", status: "error" });
    expect(ok).toBe(true);
    const sql = render(captured[0]);
    expect(sql).toContain("escalated-to-human");
    expect(sql).toContain("remaining_budget");
    // NO model escalation on an infra/timeout error — tier set to itself.
    expect(sql).not.toContain("tier + 1");
  });
});
