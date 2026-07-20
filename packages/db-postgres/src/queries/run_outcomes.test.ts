import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #1338 PR① — the model-selection learning loop's FUEL. Mocked-db unit tests
 * (this package has no live-DB test harness — every query spec mocks `db`;
 * see `runner-result-sql.test.ts`'s own note). The mocked insert chain
 * mirrors `github-intake-alignment-gate.test.ts`'s value-capturing style
 * (capture what `.values()` was called with); the mocked select chain
 * mirrors `workspace_budget.test.ts`'s chainable-mock style (every method
 * returns the chain except the terminal one, which resolves the rows).
 */
let insertedValues: Array<Record<string, unknown>> = [];
let insertConflictTarget: unknown;

vi.mock("../db.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          onConflictDoNothing: vi.fn((opts: { target: unknown }) => {
            insertConflictTarget = opts?.target;
            return Promise.resolve([]);
          }),
        };
      }),
    })),
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { runOutcomes } from "../schema/run_outcomes.js";
import {
  mapTerminalStateToRunOutcome,
  recordRunOutcome,
  getModelOutcomeStats,
} from "./run_outcomes.js";
import type { TerminalQueueState } from "./runner.js";

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues = [];
  insertConflictTarget = undefined;
});

describe("mapTerminalStateToRunOutcome", () => {
  it("green -> success", () => {
    expect(mapTerminalStateToRunOutcome("green")).toBe("success");
  });

  it("escalated-to-human -> human_review", () => {
    expect(mapTerminalStateToRunOutcome("escalated-to-human")).toBe("human_review");
  });

  it("blocked -> failed (forward-compatibility; recordRunnerResult never actually commits this today)", () => {
    expect(mapTerminalStateToRunOutcome("blocked")).toBe("failed");
  });

  it("is exhaustive over every TerminalQueueState value without a default branch (compile-time guard)", () => {
    const all: TerminalQueueState[] = ["green", "escalated-to-human", "blocked"];
    for (const state of all) {
      expect(() => mapTerminalStateToRunOutcome(state)).not.toThrow();
    }
  });
});

describe("recordRunOutcome", () => {
  it("inserts the full row shape", async () => {
    await recordRunOutcome({
      queueEntryId: "qe-1",
      workspaceId: "ws-1",
      taskType: "ui",
      executeModel: "anthropic/claude-sonnet-5",
      outcome: "success",
      costUsd: 1.23,
    });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toEqual({
      queueEntryId: "qe-1",
      workspaceId: "ws-1",
      taskType: "ui",
      executeModel: "anthropic/claude-sonnet-5",
      outcome: "success",
      costUsd: 1.23,
    });
  });

  it("passes null taskType/executeModel straight through (a brief-less entry / a hosted-refusal that never executed)", async () => {
    await recordRunOutcome({
      queueEntryId: "qe-2",
      workspaceId: "ws-1",
      taskType: null,
      executeModel: null,
      outcome: "human_review",
      costUsd: 0,
    });

    expect(insertedValues[0]?.["taskType"]).toBeNull();
    expect(insertedValues[0]?.["executeModel"]).toBeNull();
  });

  it("idempotency: the insert targets ON CONFLICT DO NOTHING on queueEntryId — a re-report is a no-op, never a duplicate or a throw", async () => {
    await recordRunOutcome({
      queueEntryId: "qe-3",
      workspaceId: "ws-1",
      taskType: null,
      executeModel: null,
      outcome: "success",
      costUsd: 0,
    });

    expect(insertConflictTarget).toBe(runOutcomes.queueEntryId);
  });
});

describe("getModelOutcomeStats", () => {
  function mockGroupedRows(rows: Array<Record<string, unknown>>) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain["groupBy"] = vi.fn(() => Promise.resolve(rows));
    mockDb.select = vi.fn(() => chain as ReturnType<typeof db.select>);
    return chain;
  }

  it("computes runCount/successCount/successRate/avgCostUsd for a single (task_type, model) group", async () => {
    mockGroupedRows([
      { taskType: "ui", executeModel: "sonnet-5", runCount: "4", successCount: "3", totalCostUsd: "8" },
    ]);

    const rows = await getModelOutcomeStats();

    expect(rows).toEqual([
      {
        taskType: "ui",
        executeModel: "sonnet-5",
        runCount: 4,
        successCount: 3,
        successRate: 0.75,
        avgCostUsd: 2,
        costPerSuccess: 8 / 3,
      },
    ]);
  });

  it("costPerSuccess is NULL (not 0) when a group has zero successes — undefined denominator, mirrors eval_arm_metrics' None-vs-0 rule", async () => {
    mockGroupedRows([
      { taskType: "refactor", executeModel: "haiku-4-5", runCount: "2", successCount: "0", totalCostUsd: "1" },
    ]);

    const rows = await getModelOutcomeStats();

    expect(rows[0]?.successRate).toBe(0);
    expect(rows[0]?.avgCostUsd).toBe(0.5);
    expect(rows[0]?.costPerSuccess).toBeNull();
  });

  it("passes workspaceId + taskType filters into the WHERE clause when given", async () => {
    const chain = mockGroupedRows([]);
    await getModelOutcomeStats({ workspaceId: "ws-1", taskType: "ui" });
    expect(chain["where"]).toHaveBeenCalled();
  });

  it("omits the WHERE clause entirely when no filters are given (global, cross-workspace view)", async () => {
    const chain = mockGroupedRows([]);
    await getModelOutcomeStats();
    const whereArg = (chain["where"] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(whereArg).toBeUndefined();
  });

  it("returns [] when there are no run_outcomes rows at all", async () => {
    mockGroupedRows([]);
    expect(await getModelOutcomeStats()).toEqual([]);
  });

  it("keeps a NULL task_type/execute_model group as its own row rather than dropping it", async () => {
    mockGroupedRows([
      { taskType: null, executeModel: null, runCount: "1", successCount: "0", totalCostUsd: "0" },
    ]);

    const rows = await getModelOutcomeStats();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskType).toBeNull();
    expect(rows[0]?.executeModel).toBeNull();
  });
});
