import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain: same "mock the chain, control the terminal value" approach
// as workspace_budget.test.ts / jace_sessions-intro-anchor.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

import { db } from "../db.js";
import { runs } from "../schema/runs.js";
import { listWorkspaceRunCosts, DEFAULT_RUN_COST_LIST_LIMIT } from "./workspace_costs.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "orderBy", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Argument-level condition assertions (see workspace_budget.test.ts for the
// full rationale): a mock chain proves a method was *called*, not what it was
// called *with* — captured arguments are drizzle SQL trees, not plain
// objects, so we render both the actual captured value and an expected one
// (built with the same drizzle operators against the real columns) to
// literal {sql, params} text via PgDialect.sqlToQuery, and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listWorkspaceRunCosts", () => {
  it("scopes to the workspace and period [start, end), ordered newest-first, capped at the default limit", async () => {
    const selectChain = makeChain("limit", [
      {
        id: "run-1",
        taskIdentity: "Fix login bug",
        status: "success",
        costUsd: 1.5,
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
      },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    expect(result).toEqual([
      {
        runId: "run-1",
        taskIdentity: "Fix login bug",
        status: "success",
        costUsd: 1.5,
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    ]);

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

    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(runs.createdAt))
    );

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(DEFAULT_RUN_COST_LIST_LIMIT);
  });

  it("honors an explicit limit override", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
      10
    );

    const limitArgs = (selectChain.limit as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(limitArgs).toBe(10);
  });

  it("falls back to the run's branch (never a bare UUID) when title is null", async () => {
    const selectChain = makeChain("limit", [
      {
        id: "run-2",
        taskIdentity: "afk/github-42",
        status: "running",
        costUsd: 0,
        createdAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    // The COALESCE(title, branch) happens in the SQL projection (asserted via
    // the .select() column-expression pin below); here we assert the mapped
    // row surfaces whatever came back verbatim, and it is never the raw run id.
    expect(result[0]!.taskIdentity).toBe("afk/github-42");
    expect(result[0]!.taskIdentity).not.toBe(result[0]!.runId);
  });

  it("pins the selected-column expressions: taskIdentity COALESCE(title, branch) and costUsd COALESCE(cost_usd, 0)", async () => {
    const selectChain = makeChain("limit", []);
    const selectSpy = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    mockDb.select = selectSpy;

    await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    const columns = selectSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(renderCondition(columns.taskIdentity)).toEqual(
      renderCondition(sql`COALESCE(${runs.title}, ${runs.branch})`)
    );
    expect(renderCondition(columns.costUsd)).toEqual(
      renderCondition(sql`COALESCE(${runs.costUsd}, 0)`)
    );
  });

  it("returns 0 (never null) when cost_usd resolves null despite the SQL COALESCE", async () => {
    const selectChain = makeChain("limit", [
      {
        id: "run-3",
        taskIdentity: "afk/github-7",
        status: "failed",
        costUsd: null,
        createdAt: new Date("2026-07-12T00:00:00.000Z"),
      },
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    expect(result[0]!.costUsd).toBe(0);
  });

  it("returns an empty array when nothing is in the period", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    expect(result).toEqual([]);
  });
});
