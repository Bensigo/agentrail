import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing queries
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import { upsertReviewGate } from "../queries/index.js";
import type { UpsertReviewGateInput } from "../queries/index.js";

const mockDb = vi.mocked(db);

// Helper to build a chainable drizzle-like mock
function makeChain(finalValue: unknown = undefined) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "from", "where", "limit",
    "orderBy", "values", "set", "onConflictDoUpdate",
    "onConflictDoNothing", "innerJoin", "leftJoin",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // onConflictDoUpdate is the terminal call in upsertReviewGate
  (chain as Record<string, unknown>).onConflictDoUpdate = vi.fn(() =>
    Promise.resolve(finalValue)
  );
  return chain;
}

const BASE_INPUT: UpsertReviewGateInput = {
  workspaceId: "ws-1",
  runId: "run-1",
  gateName: "context-evidence",
  status: "failed",
  conditions: [{ field: "context_pack_file", required: true }],
  blockingReasons: [
    { title: "Missing context pack", severity: "error", file: null, body: "context_pack_file not set" },
  ],
  evidenceRefs: [{ label: "run log", url: "https://example.com/log" }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertReviewGate", () => {
  it("calls db.insert with the correct values", async () => {
    const chain = makeChain();
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    await upsertReviewGate(BASE_INPUT);

    expect(mockDb.insert).toHaveBeenCalled();
    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls.length).toBeGreaterThan(0);
    const row = valuesCalls[0][0];
    expect(row.workspaceId).toBe("ws-1");
    expect(row.runId).toBe("run-1");
    expect(row.gateName).toBe("context-evidence");
    expect(row.status).toBe("failed");
    expect(row.blockingReasons).toEqual(BASE_INPUT.blockingReasons);
  });

  it("calls onConflictDoUpdate targeting id with status/conditions/blockingReasons/evaluatedAt", async () => {
    const chain = makeChain();
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    await upsertReviewGate({ ...BASE_INPUT, id: "gate-abc" });

    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    const conflictArgs = (chain.onConflictDoUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(conflictArgs.set.status).toBe("failed");
    expect(conflictArgs.set.conditions).toEqual(BASE_INPUT.conditions);
    expect(conflictArgs.set.blockingReasons).toEqual(BASE_INPUT.blockingReasons);
    expect(conflictArgs.set.evaluatedAt).toBeInstanceOf(Date);
  });

  it("uses provided id when given", async () => {
    const chain = makeChain();
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    await upsertReviewGate({ ...BASE_INPUT, id: "gate-xyz" });

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls[0][0].id).toBe("gate-xyz");
  });

  it("defaults evaluatedAt to now when not provided", async () => {
    const chain = makeChain();
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    const before = Date.now();
    await upsertReviewGate(BASE_INPUT);
    const after = Date.now();

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    const evaluatedAt: Date = valuesCalls[0][0].evaluatedAt;
    expect(evaluatedAt).toBeInstanceOf(Date);
    expect(evaluatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(evaluatedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("accepts a string evaluatedAt and converts to Date", async () => {
    const chain = makeChain();
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    const iso = "2026-06-12T10:00:00.000Z";
    await upsertReviewGate({ ...BASE_INPUT, evaluatedAt: iso });

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    const evaluatedAt: Date = valuesCalls[0][0].evaluatedAt;
    expect(evaluatedAt).toBeInstanceOf(Date);
    expect(evaluatedAt.toISOString()).toBe(iso);
  });

  it("defaults conditions and blockingReasons to empty arrays when omitted", async () => {
    const chain = makeChain();
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    await upsertReviewGate({
      workspaceId: "ws-1",
      runId: "run-1",
      gateName: "context-evidence",
      status: "passed",
    });

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    const row = valuesCalls[0][0];
    expect(row.conditions).toEqual([]);
    expect(row.blockingReasons).toEqual([]);
  });
});
