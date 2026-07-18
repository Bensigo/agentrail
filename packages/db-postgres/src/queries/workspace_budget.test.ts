import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-intro-anchor.test.ts / chat_identities.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { runs } from "../schema/runs.js";
import {
  getWorkspaceBudgetState,
  sumWorkspaceSpendSince,
  markBudgetExhaustedNotified,
} from "./workspace_budget.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "limit", "set"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Argument-level condition assertions (see jace_sessions-intro-anchor.test.ts
// for the full rationale): a mock chain proves a method was *called*, not
// what it was called *with* — a captured `.where(...)` argument is a drizzle
// SQL condition tree, not a plain object, so we render both the actual
// captured condition and an expected one (built with the same drizzle
// operators against the real columns) to literal {sql, params} text via
// PgDialect.sqlToQuery, and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWorkspaceBudgetState", () => {
  it("selects the ceiling + notified period scoped to the workspace id, capped at one row", async () => {
    const selectChain = makeChain("limit", [
      { monthlyBudgetUsd: 25, budgetExhaustedNotifiedPeriod: "2026-06" },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceBudgetState("ws-1");

    expect(result).toEqual({
      monthlyBudgetUsd: 25,
      budgetExhaustedNotifiedPeriod: "2026-06",
    });

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(workspaces.id, "ws-1"))
    );

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(1);
  });

  it("returns null when the workspace row does not exist", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getWorkspaceBudgetState("ws-missing");

    expect(result).toBeNull();
  });
});

describe("sumWorkspaceSpendSince", () => {
  it("sums cost_usd scoped to the workspace within [periodStartIso, periodEndIso)", async () => {
    const selectChain = makeChain("where", [{ total: 10.5 }]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await sumWorkspaceSpendSince(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    expect(result).toBe(10.5);

    // Argument-level: a mutation that dropped either bound (e.g. matching ANY
    // date, or the wrong workspace) would still pass a naive "returns a
    // number" assertion but changes the rendered WHERE text, so it is caught
    // here.
    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(runs.workspaceId, "ws-1"),
          gte(runs.createdAt, new Date("2026-07-01T00:00:00.000Z")),
          lt(runs.createdAt, new Date("2026-08-01T00:00:00.000Z"))
        )
      )
    );
  });

  it("returns 0 (never null) when the aggregate itself is null", async () => {
    const selectChain = makeChain("where", [{ total: null }]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await sumWorkspaceSpendSince(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    expect(result).toBe(0);
  });

  it("returns 0 when the select resolves no rows at all", async () => {
    const selectChain = makeChain("where", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await sumWorkspaceSpendSince(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    expect(result).toBe(0);
  });
});

describe("markBudgetExhaustedNotified", () => {
  it("flips the notified period and returns true when the stored period differs (first exhaustion)", async () => {
    const updateChain = makeChain("returning", [{ id: "ws-1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await markBudgetExhaustedNotified("ws-1", "2026-07");

    expect(result).toBe(true);

    const setArgs = (updateChain.set as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(setArgs).toEqual({ budgetExhaustedNotifiedPeriod: "2026-07" });

    // The IS DISTINCT FROM guard (not `!=`) is the whole race-safety
    // mechanism — `!=` against a NULL stored value is unknown/never-true and
    // would never flip on the very first exhaustion. Rendered to literal SQL
    // since the captured condition is a freshly-built tree each call.
    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(workspaces.id, "ws-1"),
          sql`${workspaces.budgetExhaustedNotifiedPeriod} IS DISTINCT FROM ${"2026-07"}`
        )
      )
    );
  });

  it("returns false on a second call for the SAME period — exactly-once notify", async () => {
    // Models the real guard excluding the row: the stored period already
    // equals "2026-07", so a real UPDATE with this WHERE matches zero rows.
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await markBudgetExhaustedNotified("ws-1", "2026-07");

    expect(result).toBe(false);
  });

  it("flips again for a DIFFERENT period (re-exhaustion in a later period is a fresh notify)", async () => {
    const updateChain = makeChain("returning", [{ id: "ws-1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await markBudgetExhaustedNotified("ws-1", "2026-08");

    expect(result).toBe(true);

    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(workspaces.id, "ws-1"),
          sql`${workspaces.budgetExhaustedNotifiedPeriod} IS DISTINCT FROM ${"2026-08"}`
        )
      )
    );
  });
});
