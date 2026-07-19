import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * `setMergePermission` mirrors `createWorkspaceOwnerElect`'s test idiom
 * exactly (see `__tests__/create-workspace-owner-elect.test.ts`): there is
 * no live-DB harness in this package, so `db.transaction` is mocked to run
 * its callback against the same mock `db`, capturing statement order/
 * arguments and letting an injected error propagate the way a real Postgres
 * abort would.
 */

const mockState = vi.hoisted(() => ({
  calls: [] as string[],
  updateTable: undefined as unknown,
  updateSet: undefined as unknown,
  updateWhere: undefined as unknown,
  insertTable: undefined as unknown,
  insertValues: undefined as unknown,
  insertError: undefined as Error | undefined,
  returningRow: undefined as unknown,
  selectRows: [] as unknown[],
}));

vi.mock("../db.js", () => {
  const db = {
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
    update: (table: unknown) => {
      mockState.updateTable = table;
      return {
        set: (s: unknown) => {
          mockState.updateSet = s;
          return {
            where: async (w: unknown) => {
              mockState.calls.push("update");
              mockState.updateWhere = w;
              return undefined;
            },
          };
        },
      };
    },
    insert: (table: unknown) => {
      mockState.insertTable = table;
      return {
        values: (v: unknown) => {
          mockState.insertValues = v;
          return {
            returning: async () => {
              mockState.calls.push("insert");
              if (mockState.insertError) throw mockState.insertError;
              return [mockState.returningRow];
            },
          };
        },
      };
    },
    // Two distinct call shapes share this mock: getMergePermission is
    // select().from().where().limit(); latestGrantEvent is
    // select().from().innerJoin().where().orderBy().limit(). Both terminal
    // legs resolve to the same mockState.selectRows.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mockState.selectRows,
        }),
        innerJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => mockState.selectRows,
            }),
          }),
        }),
      }),
    }),
  };
  return { db };
});

import { workspaces } from "../schema/workspaces.js";
import { workspaceGrantEvents } from "../schema/workspace_grant_events.js";
import {
  MERGE_PERMISSION_SETTING,
  getMergePermission,
  setMergePermission,
  latestGrantEvent,
} from "./workspace_grants.js";

const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-19T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockState.calls = [];
  mockState.updateTable = undefined;
  mockState.updateSet = undefined;
  mockState.updateWhere = undefined;
  mockState.insertTable = undefined;
  mockState.insertValues = undefined;
  mockState.insertError = undefined;
  mockState.returningRow = { id: "grant-event-1" };
  mockState.selectRows = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getMergePermission", () => {
  it("returns the workspace's stored bit", async () => {
    mockState.selectRows = [{ mergePermission: true }];
    await expect(getMergePermission("ws-1")).resolves.toBe(true);
  });

  it("defaults to false when the workspace row doesn't resolve", async () => {
    mockState.selectRows = [];
    await expect(getMergePermission("ws-missing")).resolves.toBe(false);
  });
});

describe("setMergePermission", () => {
  it("updates workspaces.merge_permission, scoped to exactly this workspace", async () => {
    await setMergePermission({
      workspaceId: "ws-1",
      granted: true,
      grantedByUserId: "user-1",
    });

    expect(mockState.updateTable).toBe(workspaces);
    expect(mockState.updateSet).toEqual({ mergePermission: true, updatedAt: NOW });
    expect(renderCondition(mockState.updateWhere)).toEqual(
      renderCondition(eq(workspaces.id, "ws-1"))
    );
  });

  it("inserts the audit row with the setting name, granted bit, and actor id", async () => {
    await setMergePermission({
      workspaceId: "ws-1",
      granted: true,
      grantedByUserId: "user-1",
    });

    expect(mockState.insertTable).toBe(workspaceGrantEvents);
    expect(mockState.insertValues).toEqual({
      workspaceId: "ws-1",
      setting: MERGE_PERMISSION_SETTING,
      granted: true,
      grantedByUserId: "user-1",
    });
  });

  it("records a revoke (granted: false) identically to a grant", async () => {
    await setMergePermission({
      workspaceId: "ws-1",
      granted: false,
      grantedByUserId: "user-1",
    });

    expect(mockState.updateSet).toEqual({ mergePermission: false, updatedAt: NOW });
    expect((mockState.insertValues as { granted: boolean }).granted).toBe(false);
  });

  it("runs the column flip THEN the audit insert, exactly once each, inside one transaction", async () => {
    await setMergePermission({
      workspaceId: "ws-1",
      granted: true,
      grantedByUserId: "user-1",
    });

    expect(mockState.calls).toEqual(["update", "insert"]);
  });

  it("returns the granted bit and the new audit row's id", async () => {
    mockState.returningRow = { id: "grant-event-9" };

    const result = await setMergePermission({
      workspaceId: "ws-1",
      granted: true,
      grantedByUserId: "user-1",
    });

    expect(result).toEqual({ mergePermission: true, grantEventId: "grant-event-9" });
  });

  it("propagates a thrown audit-insert error — the transaction wrapper rolls back the column flip with it (the audit row is not optional)", async () => {
    const err = new Error("insert failed");
    mockState.insertError = err;

    await expect(
      setMergePermission({ workspaceId: "ws-1", granted: true, grantedByUserId: "user-1" })
    ).rejects.toThrow(err);

    // Both statements were issued against the SAME `tx` inside ONE
    // `db.transaction` call — a real Postgres transaction aborts (rolling
    // back the update too) the instant the insert throws, which is exactly
    // why the write must never be split into two separate `db` calls.
    expect(mockState.calls).toEqual(["update", "insert"]);
  });
});

describe("latestGrantEvent", () => {
  it("returns null when the setting has never been touched", async () => {
    mockState.selectRows = [];
    await expect(latestGrantEvent("ws-1")).resolves.toBeNull();
  });

  it("returns the joined row (granted, createdAt, granter name/email — never a raw id)", async () => {
    mockState.selectRows = [
      {
        granted: true,
        createdAt: NOW,
        grantedByName: "Ada Lovelace",
        grantedByEmail: "ada@example.com",
      },
    ];

    await expect(latestGrantEvent("ws-1")).resolves.toEqual({
      granted: true,
      createdAt: NOW,
      grantedByName: "Ada Lovelace",
      grantedByEmail: "ada@example.com",
    });
  });
});
