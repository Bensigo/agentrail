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

// getWorkspaceCostOverview is pure composition over these two (#1269)
// helpers — mocked directly (not the db chain) so its tests assert
// composition logic, not re-derive workspace_budget.ts's own SQL.
vi.mock("./workspace_budget.js", () => ({
  getWorkspaceBudgetState: vi.fn(),
  sumWorkspaceSpendSince: vi.fn(),
}));

import { db } from "../db.js";
import { runs } from "../schema/runs.js";
import { queueEntries } from "../schema/queue_entries.js";
import {
  getWorkspaceBudgetState,
  sumWorkspaceSpendSince,
} from "./workspace_budget.js";
import {
  listWorkspaceRunCosts,
  DEFAULT_RUN_COST_LIST_LIMIT,
  workspaceMonthlyCostRollup,
  DEFAULT_MONTHLY_ROLLUP_MONTHS,
  getWorkspaceCostOverview,
} from "./workspace_costs.js";

const mockDb = vi.mocked(db);
const mockGetWorkspaceBudgetState = vi.mocked(getWorkspaceBudgetState);
const mockSumWorkspaceSpendSince = vi.mocked(sumWorkspaceSpendSince);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "leftJoin", "where", "orderBy", "limit"];
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

  it("surfaces the joined queue-entry title (never a bare UUID) for a heartbeat-registered run whose runs.title is null", async () => {
    // Models the real third-writer rows verified live on the dev DB (e.g.
    // run 43dc7116…): agentrail/afk/queue_store.py's register_run writes NO
    // title, but its queue_entry_id resolves to a queue_entries row with a
    // real one — the LEFT JOIN + three-tier COALESCE (pinned at argument
    // level below) is what surfaces it.
    const selectChain = makeChain("limit", [
      {
        id: "run-2",
        taskIdentity: "Context Compiler: compute precision-at-budget live",
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

    expect(result[0]!.taskIdentity).toBe(
      "Context Compiler: compute precision-at-budget live"
    );
    expect(result[0]!.taskIdentity).not.toBe(result[0]!.runId);
  });

  it("pins the selected-column expressions: taskIdentity three-tier COALESCE(runs.title, queue_entries.title, runs.branch) and costUsd COALESCE(cost_usd, 0)", async () => {
    const selectChain = makeChain("limit", []);
    const selectSpy = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    mockDb.select = selectSpy;

    await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    // Tier order matters: runs.title (claim-path denormalized copy) wins,
    // then the joined queue_entries.title (heartbeat register_run rows,
    // which write no runs.title), then runs.branch (NOT NULL everywhere) as
    // the never-a-UUID floor. A mutation that dropped the middle tier would
    // regress heartbeat rows back to branch slugs and is caught here.
    const columns = selectSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(renderCondition(columns.taskIdentity)).toEqual(
      renderCondition(
        sql`COALESCE(${runs.title}, ${queueEntries.title}, ${runs.branch})`
      )
    );
    expect(renderCondition(columns.costUsd)).toEqual(
      renderCondition(sql`COALESCE(${runs.costUsd}, 0)`)
    );
  });

  it("LEFT JOINs queue_entries on runs.queue_entry_id (left, not inner — upsertRun rows have no queue entry at all)", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await listWorkspaceRunCosts(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );

    const leftJoinCalls = (selectChain.leftJoin as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(leftJoinCalls).toHaveLength(1);
    expect(leftJoinCalls[0]?.[0]).toBe(queueEntries);
    expect(renderCondition(leftJoinCalls[0]?.[1])).toEqual(
      renderCondition(eq(runs.queueEntryId, queueEntries.id))
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

describe("workspaceMonthlyCostRollup", () => {
  // Fixed "now" so UTC month math is deterministic across the whole suite.
  const NOW = new Date("2026-07-15T12:00:00.000Z");

  it("pins the rendered SQL: workspace scope, half-open window over the full span, UTC year/month EXTRACT+cast bucketing reused in SELECT/GROUP BY/ORDER BY, NULL-safe SUM, ::int-cast COUNT", async () => {
    mockDb.execute = vi.fn(() => Promise.resolve([]));

    await workspaceMonthlyCostRollup("ws-1", 2, NOW);

    const executedArg = (mockDb.execute as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];

    const yearExpr = sql`EXTRACT(YEAR FROM ${runs.createdAt} AT TIME ZONE 'UTC')::int`;
    const monthExpr = sql`EXTRACT(MONTH FROM ${runs.createdAt} AT TIME ZONE 'UTC')::int`;
    // Window bounds are plain ISO strings, NOT `new Date(...)` — verified
    // against the real dev DB (not just this mock): a raw Date object
    // interpolated into a db.execute(sql`...`) template reaches postgres.js's
    // parameter binder un-serialized and throws ERR_INVALID_ARG_TYPE. The
    // fluent builder (listWorkspaceRunCosts above) doesn't hit this because
    // it has column-type context to serialize with; a raw sql template does
    // not, so this MUST stay a string.
    const expected = sql`
    SELECT
      ${yearExpr} AS bucket_year,
      ${monthExpr} AS bucket_month,
      COALESCE(SUM(${runs.costUsd}), 0) AS total_cost_usd,
      COUNT(*)::int AS run_count
    FROM ${runs}
    WHERE ${runs.workspaceId} = ${"ws-1"}
      AND ${runs.createdAt} >= ${"2026-06-01T00:00:00.000Z"}
      AND ${runs.createdAt} < ${"2026-08-01T00:00:00.000Z"}
    GROUP BY ${yearExpr}, ${monthExpr}
    ORDER BY ${yearExpr} ASC, ${monthExpr} ASC
  `;

    expect(renderCondition(executedArg)).toEqual(renderCondition(expected));

    // Direct type guard on the window-bound params: this is the regression
    // test for the exact crash found by running this query against the real
    // dev DB (not just this mock) — a raw Date object interpolated into a
    // db.execute(sql`...`) template throws ERR_INVALID_ARG_TYPE at the
    // driver level, something no mocked-chain test can surface on its own.
    const rendered = renderCondition(executedArg);
    expect(typeof rendered.params[1]).toBe("string");
    expect(typeof rendered.params[2]).toBe("string");
  });

  it("zero-fills months with no runs, oldest-first, ending at the current partial month", async () => {
    mockDb.execute = vi.fn(() =>
      Promise.resolve([{ bucket_year: 2026, bucket_month: 7, total_cost_usd: 4.25, run_count: 2 }])
    );

    const result = await workspaceMonthlyCostRollup("ws-1", 3, NOW);

    expect(result).toEqual([
      { monthKey: "2026-05", totalCostUsd: 0, runCount: 0 },
      { monthKey: "2026-06", totalCostUsd: 0, runCount: 0 },
      { monthKey: "2026-07", totalCostUsd: 4.25, runCount: 2 },
    ]);
  });

  it("coerces string-shaped aggregate values (postgres.js returns bigint/numeric as strings by default) to genuine JS numbers", async () => {
    // Simulates what a regression dropping the ::int cast (or a bare
    // date_trunc grouping key) would actually hand back from the driver.
    mockDb.execute = vi.fn(() =>
      Promise.resolve([{ bucket_year: "2026", bucket_month: "7", total_cost_usd: "12.50", run_count: "3" }])
    );

    const result = await workspaceMonthlyCostRollup("ws-1", 1, NOW);

    expect(result).toEqual([{ monthKey: "2026-07", totalCostUsd: 12.5, runCount: 3 }]);
    expect(typeof result[0]!.totalCostUsd).toBe("number");
    expect(typeof result[0]!.runCount).toBe("number");
  });

  it("sums to 0 (never null) for a month whose rows are all legacy NULL cost_usd", async () => {
    mockDb.execute = vi.fn(() =>
      Promise.resolve([{ bucket_year: 2026, bucket_month: 7, total_cost_usd: null, run_count: 1 }])
    );

    const result = await workspaceMonthlyCostRollup("ws-1", 1, NOW);

    expect(result).toEqual([{ monthKey: "2026-07", totalCostUsd: 0, runCount: 1 }]);
  });

  it("defaults to DEFAULT_MONTHLY_ROLLUP_MONTHS when monthsBack is omitted", async () => {
    mockDb.execute = vi.fn(() => Promise.resolve([]));

    const result = await workspaceMonthlyCostRollup("ws-1", undefined, NOW);

    expect(result).toHaveLength(DEFAULT_MONTHLY_ROLLUP_MONTHS);
    expect(result[result.length - 1]!.monthKey).toBe("2026-07");
  });

  it("clamps a zero/negative monthsBack to at least the current month", async () => {
    mockDb.execute = vi.fn(() => Promise.resolve([]));

    const result = await workspaceMonthlyCostRollup("ws-1", 0, NOW);

    expect(result).toEqual([{ monthKey: "2026-07", totalCostUsd: 0, runCount: 0 }]);
  });

  it("steps back across a UTC year boundary correctly", async () => {
    mockDb.execute = vi.fn(() => Promise.resolve([]));

    const result = await workspaceMonthlyCostRollup(
      "ws-1",
      3,
      new Date("2026-01-15T00:00:00.000Z")
    );

    expect(result.map((r) => r.monthKey)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
});

describe("getWorkspaceCostOverview", () => {
  const NOW = new Date("2026-07-15T12:00:00.000Z");

  it("returns null when the workspace does not exist, and never calls sumWorkspaceSpendSince", async () => {
    mockGetWorkspaceBudgetState.mockResolvedValue(null);

    const result = await getWorkspaceCostOverview("ws-missing", NOW);

    expect(result).toBeNull();
    expect(mockSumWorkspaceSpendSince).not.toHaveBeenCalled();
  });

  it("reports capStatus 'uncapped' when monthlyBudgetUsd is null, but still surfaces the real current-month spend", async () => {
    mockGetWorkspaceBudgetState.mockResolvedValue({
      monthlyBudgetUsd: null,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumWorkspaceSpendSince.mockResolvedValue(42.5);

    const result = await getWorkspaceCostOverview("ws-1", NOW);

    expect(result).toEqual({
      currentMonthSpendUsd: 42.5,
      monthlyBudgetUsd: null,
      budgetExhaustedNotifiedPeriod: null,
      capStatus: "uncapped",
    });
  });

  it("reports capStatus 'under' when spend is below the ceiling", async () => {
    mockGetWorkspaceBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 100,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumWorkspaceSpendSince.mockResolvedValue(50);

    const result = await getWorkspaceCostOverview("ws-1", NOW);

    expect(result?.capStatus).toBe("under");
  });

  it("reports capStatus 'exhausted' exactly AT the ceiling boundary (spend === ceiling proves >=, not >)", async () => {
    mockGetWorkspaceBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 100,
      budgetExhaustedNotifiedPeriod: "2026-07",
    });
    mockSumWorkspaceSpendSince.mockResolvedValue(100);

    const result = await getWorkspaceCostOverview("ws-1", NOW);

    expect(result).toEqual({
      currentMonthSpendUsd: 100,
      monthlyBudgetUsd: 100,
      budgetExhaustedNotifiedPeriod: "2026-07",
      capStatus: "exhausted",
    });
  });

  it("reports capStatus 'exhausted' when spend has gone past the ceiling", async () => {
    mockGetWorkspaceBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 100,
      budgetExhaustedNotifiedPeriod: "2026-07",
    });
    mockSumWorkspaceSpendSince.mockResolvedValue(150);

    const result = await getWorkspaceCostOverview("ws-1", NOW);

    expect(result?.capStatus).toBe("exhausted");
  });

  it("passes the current UTC month's [start, end) bounds to sumWorkspaceSpendSince", async () => {
    mockGetWorkspaceBudgetState.mockResolvedValue({
      monthlyBudgetUsd: 10,
      budgetExhaustedNotifiedPeriod: null,
    });
    mockSumWorkspaceSpendSince.mockResolvedValue(0);

    await getWorkspaceCostOverview("ws-1", NOW);

    expect(mockSumWorkspaceSpendSince).toHaveBeenCalledWith(
      "ws-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );
  });
});
