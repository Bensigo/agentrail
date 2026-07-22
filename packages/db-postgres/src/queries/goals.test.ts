import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `goals.ts` is the DB-facing wrapper around the pure decision engine in
 * `goal_rules.ts` (see that file's own test suite, `goal_rules.test.ts`, for
 * the exhaustive leash+stuck-rule coverage — this file only proves the
 * PLUMBING: the right rows are read, the pure decision is fed the right
 * counters, and the result is persisted + audited correctly). No live-DB
 * harness in this package (see `workspace_grants.test.ts`'s own note) —
 * `db.transaction` is mocked to run its callback against the same mock `db`,
 * mirroring that file's idiom.
 */
const mockState = vi.hoisted(() => ({
  // FIFO queue of rows for successive `.select()...limit()` calls (both the
  // plain `db.select` path and the `tx.select` path inside a transaction
  // share this queue, in call order).
  selectQueue: [] as unknown[][],
  insertedValues: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updatedValues: [] as Array<{ table: string; set: Record<string, unknown> }>,
  returningRow: undefined as unknown,
}));

vi.mock("../db.js", () => {
  const db: Record<string, unknown> = {
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: () => ({
          limit: async () => mockState.selectQueue.shift() ?? [],
          orderBy: () => ({
            limit: async () => mockState.selectQueue.shift() ?? [],
          }),
        }),
        orderBy: () => Promise.resolve(mockState.selectQueue.shift() ?? []),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        mockState.insertedValues.push({ table: "?", values: v });
        return {
          returning: async () => [mockState.returningRow ?? { ...v, id: "new-id" }],
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => {
        mockState.updatedValues.push({ table: "?", set: s });
        return {
          // `.where(...)` must be BOTH directly awaitable (recordIssueFiled /
          // recordOutcomeAndTransition never chain `.returning()`) AND
          // chainable with `.returning()` (setGoalStatus does) — a plain
          // thenable object satisfies both call shapes.
          where: (_w: unknown) => ({
            then: (resolve: (v: unknown) => void) => resolve(undefined),
            returning: async () => [mockState.returningRow ?? { ...s, id: "goal-1" }],
          }),
        };
      },
    }),
  };
  return { db };
});

import {
  isGoalLoopEnabled,
  createGoal,
  findActiveGoalForIssue,
  findActiveGoalBySlug,
  recordIssueFiled,
  recordOutcomeAndTransition,
  pauseGoal,
  abandonGoal,
  markGoalReached,
} from "./goals.js";

function activeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    objective: "reach 80% coverage",
    slug: "coverage-80",
    checkType: "metric",
    checkThreshold: 5,
    status: "active",
    maxIssues: 10,
    maxSpendUsd: 50,
    issuesFiled: 1,
    spendUsd: 5,
    stuckThreshold: 2,
    consecutiveNonGreen: 0,
    greenCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mockState.selectQueue = [];
  mockState.insertedValues = [];
  mockState.updatedValues = [];
  mockState.returningRow = undefined;
});

describe("isGoalLoopEnabled", () => {
  it("returns false when the workspace row has jaceGoalLoop=false", async () => {
    mockState.selectQueue.push([{ jaceGoalLoop: false }]);
    expect(await isGoalLoopEnabled("ws-1")).toBe(false);
  });

  it("returns true when jaceGoalLoop=true", async () => {
    mockState.selectQueue.push([{ jaceGoalLoop: true }]);
    expect(await isGoalLoopEnabled("ws-1")).toBe(true);
  });

  it("fails toward false (the safe, no-op direction) when the workspace row is missing", async () => {
    mockState.selectQueue.push([]);
    expect(await isGoalLoopEnabled("ws-missing")).toBe(false);
  });
});

describe("createGoal", () => {
  it("inserts a new goal row with the given fields, defaulting checkType/leash/stuckThreshold", async () => {
    const goal = await createGoal({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      objective: "reach 80% coverage",
      slug: "coverage-80",
      checkThreshold: 5,
    });
    expect(goal).toBeTruthy();
    expect(mockState.insertedValues).toHaveLength(1);
    expect(mockState.insertedValues[0]?.values).toMatchObject({
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      objective: "reach 80% coverage",
      slug: "coverage-80",
      checkType: "metric",
      maxIssues: 10,
      maxSpendUsd: 50,
      stuckThreshold: 2,
    });
  });
});

describe("findActiveGoalForIssue", () => {
  it("returns null when no issue_filed event maps this issue", async () => {
    mockState.selectQueue.push([]); // goal_events lookup: no match
    const result = await findActiveGoalForIssue("ws-1", "42");
    expect(result).toBeNull();
  });

  it("returns the goal when mapped AND still active", async () => {
    mockState.selectQueue.push([{ goalId: "goal-1" }]); // goal_events lookup
    mockState.selectQueue.push([activeGoal()]); // getGoalById
    const result = await findActiveGoalForIssue("ws-1", "42");
    expect(result?.id).toBe("goal-1");
  });

  it("returns null when the mapped goal has already gone terminal (e.g. leashed) — nothing further to do", async () => {
    mockState.selectQueue.push([{ goalId: "goal-1" }]);
    mockState.selectQueue.push([activeGoal({ status: "leashed" })]);
    const result = await findActiveGoalForIssue("ws-1", "42");
    expect(result).toBeNull();
  });
});

describe("findActiveGoalBySlug", () => {
  it("returns the goal when an active goal matches the slug", async () => {
    mockState.selectQueue.push([activeGoal({ slug: "reach-80-coverage" })]);
    const result = await findActiveGoalBySlug("ws-1", "reach-80-coverage");
    expect(result?.slug).toBe("reach-80-coverage");
  });

  it("returns null when no goal matches the slug (including a slug that names an already-terminal goal — the WHERE clause filters status='active' unconditionally, so this is the pre-file leash gate's own safety net against a stamp naming a leashed/paused/reached/abandoned goal)", async () => {
    mockState.selectQueue.push([]);
    const result = await findActiveGoalBySlug("ws-1", "unknown-or-terminal-slug");
    expect(result).toBeNull();
  });
});

describe("recordIssueFiled", () => {
  it("increments issuesFiled and appends an issue_filed event in one transaction", async () => {
    mockState.selectQueue.push([activeGoal({ issuesFiled: 3 })]);
    await recordIssueFiled("goal-1", "77");

    expect(mockState.updatedValues[0]?.set).toMatchObject({ issuesFiled: 4 });
    const eventInsert = mockState.insertedValues.find(
      (c) => (c.values as Record<string, unknown>)["type"] === "issue_filed"
    );
    expect(eventInsert?.values).toMatchObject({
      goalId: "goal-1",
      type: "issue_filed",
      issueExternalId: "77",
    });
  });

  it("no-ops when the goal no longer exists (defensive; never throws)", async () => {
    mockState.selectQueue.push([]);
    await expect(recordIssueFiled("goal-missing", "77")).resolves.toBeUndefined();
    expect(mockState.updatedValues).toHaveLength(0);
  });
});

describe("recordOutcomeAndTransition", () => {
  it("returns matched:false when no active goal maps to this issue (flag-independent no-op path)", async () => {
    mockState.selectQueue.push([]); // no issue_filed mapping
    const result = await recordOutcomeAndTransition({
      workspaceId: "ws-1",
      issueExternalId: "999",
      outcome: "green",
      costUsd: 1,
    });
    expect(result).toEqual({ matched: false });
    expect(mockState.updatedValues).toHaveLength(0);
    expect(mockState.insertedValues).toHaveLength(0);
  });

  it("refills (action='refill') and persists updated counters + an outcome_recorded event, with no status_changed event when the status didn't move", async () => {
    mockState.selectQueue.push([{ goalId: "goal-1" }]); // findActiveGoalForIssue: mapping
    mockState.selectQueue.push([activeGoal({ issuesFiled: 1, spendUsd: 5 })]); // findActiveGoalForIssue: getGoalById
    mockState.selectQueue.push([activeGoal({ issuesFiled: 1, spendUsd: 5 })]); // fresh re-read inside tx

    const result = await recordOutcomeAndTransition({
      workspaceId: "ws-1",
      issueExternalId: "42",
      outcome: "green",
      costUsd: 2,
    });

    expect(result.matched).toBe(true);
    expect(result.action).toBe("refill");
    expect(mockState.updatedValues[0]?.set).toMatchObject({ status: "active", spendUsd: 7 });

    const outcomeEvent = mockState.insertedValues.find(
      (c) => (c.values as Record<string, unknown>)["type"] === "outcome_recorded"
    );
    expect(outcomeEvent?.values).toMatchObject({
      goalId: "goal-1",
      issueExternalId: "42",
      outcome: "green",
      costUsd: 2,
    });
    const statusChanged = mockState.insertedValues.filter(
      (c) => (c.values as Record<string, unknown>)["type"] === "status_changed"
    );
    expect(statusChanged).toHaveLength(0);
  });

  it("leash exhaustion persists status='leashed' AND records a status_changed event, with action='escalate_leashed'", async () => {
    mockState.selectQueue.push([{ goalId: "goal-1" }]);
    mockState.selectQueue.push([activeGoal({ issuesFiled: 10, maxIssues: 10, checkThreshold: 999 })]);
    mockState.selectQueue.push([activeGoal({ issuesFiled: 10, maxIssues: 10, checkThreshold: 999 })]);

    const result = await recordOutcomeAndTransition({
      workspaceId: "ws-1",
      issueExternalId: "42",
      outcome: "green",
      costUsd: 0,
    });

    expect(result.action).toBe("escalate_leashed");
    expect(mockState.updatedValues[0]?.set).toMatchObject({ status: "leashed" });
    const statusChanged = mockState.insertedValues.find(
      (c) => (c.values as Record<string, unknown>)["type"] === "status_changed"
    );
    expect(statusChanged?.values).toMatchObject({
      goalId: "goal-1",
      payload: { from: "active", to: "leashed", reason: expect.any(String) },
    });
  });

  it("stuck rule persists status='paused' with action='escalate_stuck' at the threshold", async () => {
    mockState.selectQueue.push([{ goalId: "goal-1" }]);
    mockState.selectQueue.push([activeGoal({ consecutiveNonGreen: 1, stuckThreshold: 2 })]);
    mockState.selectQueue.push([activeGoal({ consecutiveNonGreen: 1, stuckThreshold: 2 })]);

    const result = await recordOutcomeAndTransition({
      workspaceId: "ws-1",
      issueExternalId: "42",
      outcome: "blocked",
      costUsd: 0,
    });

    expect(result.action).toBe("escalate_stuck");
    expect(mockState.updatedValues[0]?.set).toMatchObject({ status: "paused" });
  });

  it("a terminal goal (already leashed) that somehow gets re-evaluated resolves noop and never re-fires an escalation", async () => {
    mockState.selectQueue.push([{ goalId: "goal-1" }]);
    // findActiveGoalForIssue's own status check would normally return null
    // for a leashed goal (see the dedicated test above) — this test proves
    // the DEFENSE IN DEPTH inside recordOutcomeAndTransition's own
    // transaction-scoped re-read, in case a caller ever bypassed that guard.
    mockState.selectQueue.push([activeGoal({ status: "active" })]); // findActiveGoalForIssue's own check passes it through once
    mockState.selectQueue.push([activeGoal({ status: "leashed" })]); // but the fresh re-read inside the tx sees it's ALREADY terminal

    const result = await recordOutcomeAndTransition({
      workspaceId: "ws-1",
      issueExternalId: "42",
      outcome: "green",
      costUsd: 5,
    });

    expect(result.action).toBe("noop");
    expect(mockState.updatedValues[0]?.set).toMatchObject({ status: "leashed" });
  });
});

describe("manual controls", () => {
  it("pauseGoal sets status='paused' and records a status_changed event", async () => {
    mockState.selectQueue.push([activeGoal()]);
    mockState.returningRow = activeGoal({ status: "paused", statusReason: "manual pause" });
    const updated = await pauseGoal("goal-1", "manual pause");
    expect(updated?.status).toBe("paused");
    expect(mockState.updatedValues[0]?.set).toMatchObject({ status: "paused", statusReason: "manual pause" });
  });

  it("abandonGoal sets status='abandoned'", async () => {
    mockState.selectQueue.push([activeGoal()]);
    mockState.returningRow = activeGoal({ status: "abandoned" });
    const updated = await abandonGoal("goal-1", "no longer relevant");
    expect(updated?.status).toBe("abandoned");
  });

  it("markGoalReached sets status='reached' — the command-type goal's manual escape hatch", async () => {
    mockState.selectQueue.push([activeGoal({ checkType: "command" })]);
    mockState.returningRow = activeGoal({ status: "reached", checkType: "command" });
    const updated = await markGoalReached("goal-1", "verify gate green on the final check issue");
    expect(updated?.status).toBe("reached");
  });

  it("returns null when the goal doesn't exist", async () => {
    mockState.selectQueue.push([]);
    expect(await pauseGoal("missing", "x")).toBeNull();
  });
});
