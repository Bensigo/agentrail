import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #1288 PR① — console chat message persistence. Mocked-db unit tests (this
 * package has no live-DB test harness — every query spec mocks `db`; see
 * `run_outcomes.test.ts`'s own note). The mocked insert chain captures what
 * `.values()` was called with and resolves `.returning()`; the mocked select
 * chain is chainable (every method but the terminal one returns itself),
 * mirroring `workspace_budget.test.ts`'s style.
 */
let insertedValues: Array<Record<string, unknown>> = [];
let insertedReturn: Array<Record<string, unknown>> = [];

vi.mock("../db.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          returning: vi.fn(() => Promise.resolve(insertedReturn)),
        };
      }),
    })),
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { appendJaceMessage, listJaceMessagesSince, hasAnyJaceReply } from "./jace_messages.js";

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues = [];
  insertedReturn = [];
});

describe("appendJaceMessage", () => {
  it("inserts the full row shape and returns the inserted row", async () => {
    insertedReturn = [
      {
        id: "m-1",
        seq: 1,
        workspaceId: "ws-1",
        conversationKey: "console:user-1:1",
        role: "user",
        text: "hello jace",
        createdAt: new Date("2026-07-22T00:00:00Z"),
      },
    ];

    const row = await appendJaceMessage({
      workspaceId: "ws-1",
      conversationKey: "console:user-1:1",
      role: "user",
      text: "hello jace",
    });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toEqual({
      workspaceId: "ws-1",
      conversationKey: "console:user-1:1",
      role: "user",
      text: "hello jace",
    });
    expect(row.id).toBe("m-1");
    expect(row.role).toBe("user");
  });

  it("throws rather than fabricate a row when the insert returns nothing (unreachable in practice)", async () => {
    insertedReturn = [];
    await expect(
      appendJaceMessage({
        workspaceId: "ws-1",
        conversationKey: "console:user-1:1",
        role: "jace",
        text: "hi there",
      })
    ).rejects.toThrow(/insert returned no row/);
  });

  it("accepts role: 'jace' — the worker/dispatch path's reply write", async () => {
    insertedReturn = [
      {
        id: "m-2",
        seq: 2,
        workspaceId: "ws-1",
        conversationKey: "console:user-1:1",
        role: "jace",
        text: "hi there",
        createdAt: new Date(),
      },
    ];
    const row = await appendJaceMessage({
      workspaceId: "ws-1",
      conversationKey: "console:user-1:1",
      role: "jace",
      text: "hi there",
    });
    expect(row.role).toBe("jace");
  });
});

describe("listJaceMessagesSince", () => {
  function mockSelectRows(rows: Array<Record<string, unknown>>) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain["limit"] = vi.fn(() => Promise.resolve(rows));
    mockDb.select = vi.fn(() => chain as ReturnType<typeof db.select>);
    return chain;
  }

  it("defaults afterSeq to 0 — the initial thread load returns everything", async () => {
    const rows = [
      { id: "m-1", seq: 1, workspaceId: "ws-1", conversationKey: "console:u:1", role: "user", text: "a", createdAt: new Date() },
      { id: "m-2", seq: 2, workspaceId: "ws-1", conversationKey: "console:u:1", role: "jace", text: "b", createdAt: new Date() },
    ];
    mockSelectRows(rows);
    const result = await listJaceMessagesSince("ws-1", "console:u:1");
    expect(result).toEqual(rows);
  });

  it("passes a workspace+conversation+seq filter into the WHERE clause", async () => {
    const chain = mockSelectRows([]);
    await listJaceMessagesSince("ws-1", "console:u:1", 5);
    expect(chain["where"]).toHaveBeenCalled();
  });

  it("orders ascending by seq (oldest first) so the thread reads top-to-bottom", async () => {
    const chain = mockSelectRows([]);
    await listJaceMessagesSince("ws-1", "console:u:1");
    expect(chain["orderBy"]).toHaveBeenCalled();
  });

  it("returns [] when there are no messages past afterSeq", async () => {
    mockSelectRows([]);
    expect(await listJaceMessagesSince("ws-1", "console:u:1", 99)).toEqual([]);
  });

  it("respects a custom limit", async () => {
    const chain = mockSelectRows([]);
    await listJaceMessagesSince("ws-1", "console:u:1", 0, 10);
    expect(chain["limit"]).toHaveBeenCalledWith(10);
  });
});

describe("hasAnyJaceReply", () => {
  function mockSelectRows(rows: Array<Record<string, unknown>>) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain["limit"] = vi.fn(() => Promise.resolve(rows));
    mockDb.select = vi.fn(() => chain as ReturnType<typeof db.select>);
    return chain;
  }

  it("true when at least one role: 'jace' row exists for the workspace", async () => {
    mockSelectRows([{ id: "m-1" }]);
    expect(await hasAnyJaceReply("ws-1")).toBe(true);
  });

  it("false when no jace reply exists yet", async () => {
    mockSelectRows([]);
    expect(await hasAnyJaceReply("ws-1")).toBe(false);
  });

  it("scopes the check to the workspace via the WHERE clause", async () => {
    const chain = mockSelectRows([]);
    await hasAnyJaceReply("ws-1");
    expect(chain["where"]).toHaveBeenCalled();
  });
});
