import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1276 PR ② — `requeueParkedQueueEntry`, the console approvals page's
 * Requeue action for a guardrail/dependency park. Argument-level (no real
 * Postgres), a fresh isolated mock rather than extending
 * `github-intake-alignment-gate.test.ts`'s shared one — that file's `select`
 * dispatcher keys off column NAME (`requireAlignment`/`workspaceId`/`id`),
 * and this function's own select shape (`{state, parkReason}`) doesn't
 * collide with any of those, but a dedicated mock keeps this file's blast
 * radius on the existing, already-passing suite at zero.
 */
let mockRow: { state: string; parkReason: string | null } | undefined;
let updateCalls: Array<Record<string, unknown>> = [];
let updateMatches: boolean;

vi.mock("../db.js", () => {
  const dbMock = {
    select: (_cols?: Record<string, unknown>) => ({
      from: () => ({
        where: async () => (mockRow ? [mockRow] : []),
      }),
    }),
    update: vi.fn(() => ({
      set: vi.fn((s: Record<string, unknown>) => {
        updateCalls.push(s);
        return {
          where: () => ({
            returning: async () => (updateMatches ? [{ id: "row-id" }] : []),
          }),
        };
      }),
    })),
    transaction: async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock),
  };
  return { db: dbMock };
});

import {
  requeueParkedQueueEntry,
  ALIGNMENT_PARK_REASON,
  ALIGNMENT_DENIED_PARK_REASON,
} from "../queries/github_intake.js";

beforeEach(() => {
  mockRow = undefined;
  updateCalls = [];
  updateMatches = true;
});

describe("requeueParkedQueueEntry", () => {
  it("not_found: no row matches (wrong id, or an id from another workspace)", async () => {
    mockRow = undefined;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("not_found");
    expect(updateCalls).toHaveLength(0);
  });

  it("not_parked: the row exists but isn't currently parked", async () => {
    mockRow = { state: "queued", parkReason: null };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("not_parked");
    expect(updateCalls).toHaveLength(0);
  });

  it("alignment_locked: refuses a park held by ALIGNMENT_PARK_REASON (never bypass the gate #1274 built)", async () => {
    mockRow = { state: "parked", parkReason: ALIGNMENT_PARK_REASON };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("alignment_locked");
    expect(updateCalls).toHaveLength(0);
  });

  it("alignment_locked: refuses a park held by ALIGNMENT_DENIED_PARK_REASON too", async () => {
    mockRow = { state: "parked", parkReason: ALIGNMENT_DENIED_PARK_REASON };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("alignment_locked");
    expect(updateCalls).toHaveLength(0);
  });

  it("requeued: a guardrail park (duplicate content) flips to queued, parkReason cleared", async () => {
    mockRow = { state: "parked", parkReason: "duplicate content: ..." };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
    expect(updateCalls[0]?.["state"]).toBe("queued");
    expect(updateCalls[0]?.["parkReason"]).toBeNull();
  });

  it("requeued: a dependency park (\"Waiting on #N\") also requeues", async () => {
    mockRow = { state: "parked", parkReason: "Waiting on #9" };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
  });

  it("requeued: a reasonless legacy park (null parkReason) also requeues", async () => {
    mockRow = { state: "parked", parkReason: null };
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("requeued");
  });

  it("not_parked: the read sees 'parked' but the final guarded UPDATE matches zero rows (raced out from under us)", async () => {
    mockRow = { state: "parked", parkReason: "Waiting on #9" };
    updateMatches = false;
    const result = await requeueParkedQueueEntry("ws-1", "entry-1");
    expect(result).toBe("not_parked");
  });
});
