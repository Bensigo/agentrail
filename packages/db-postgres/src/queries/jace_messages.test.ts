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
    execute: vi.fn(),
  },
}));

import { db } from "../db.js";
import {
  appendJaceMessage,
  listJaceMessagesSince,
  hasAnyJaceReply,
  listConsoleChatThreads,
} from "./jace_messages.js";

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

describe("listConsoleChatThreads", () => {
  const USER = "user-1";
  const WS = "ws-1";

  function mockExecute(rows: Array<Record<string, unknown>>) {
    mockDb.execute = vi.fn(() => Promise.resolve(rows as never)) as never;
  }

  it("derives n from the conversation key, sets the title from the first user text, and passes counts through", async () => {
    mockExecute([
      {
        conversation_key: `console:${USER}:2`,
        message_count: 4,
        last_message_at: new Date("2026-07-22T02:00:00Z"),
        first_user_text: "help me ship the picker",
      },
      {
        conversation_key: `console:${USER}:1`,
        message_count: 2,
        last_message_at: new Date("2026-07-22T01:00:00Z"),
        first_user_text: "hello jace",
      },
    ]);

    const threads = await listConsoleChatThreads(WS, USER);
    expect(threads).toEqual([
      { n: 2, title: "help me ship the picker", lastMessageAt: new Date("2026-07-22T02:00:00Z"), messageCount: 4 },
      { n: 1, title: "hello jace", lastMessageAt: new Date("2026-07-22T01:00:00Z"), messageCount: 2 },
    ]);
  });

  it("falls back to 'New chat' when a thread has no user message text", async () => {
    mockExecute([
      {
        conversation_key: `console:${USER}:3`,
        message_count: 1,
        last_message_at: new Date("2026-07-22T03:00:00Z"),
        first_user_text: null,
      },
      {
        conversation_key: `console:${USER}:4`,
        message_count: 1,
        last_message_at: new Date("2026-07-22T04:00:00Z"),
        first_user_text: "   ",
      },
    ]);

    const threads = await listConsoleChatThreads(WS, USER);
    expect(threads.map((t) => t.title)).toEqual(["New chat", "New chat"]);
  });

  it("truncates a long title to 60 chars with an ellipsis", async () => {
    const long = "x".repeat(200);
    mockExecute([
      {
        conversation_key: `console:${USER}:1`,
        message_count: 1,
        last_message_at: new Date("2026-07-22T00:00:00Z"),
        first_user_text: long,
      },
    ]);

    const [thread] = await listConsoleChatThreads(WS, USER);
    expect(thread!.title).toHaveLength(60);
    expect(thread!.title.endsWith("…")).toBe(true);
  });

  it("skips rows whose key suffix is not a positive integer (defensive)", async () => {
    mockExecute([
      {
        conversation_key: `console:${USER}:abc`,
        message_count: 1,
        last_message_at: new Date(),
        first_user_text: "junk",
      },
      {
        conversation_key: `console:${USER}:0`,
        message_count: 1,
        last_message_at: new Date(),
        first_user_text: "zero",
      },
      {
        conversation_key: `console:${USER}:5`,
        message_count: 1,
        last_message_at: new Date("2026-07-22T00:00:00Z"),
        first_user_text: "ok",
      },
    ]);

    const threads = await listConsoleChatThreads(WS, USER);
    expect(threads.map((t) => t.n)).toEqual([5]);
  });

  it("returns [] when the member has no threads yet", async () => {
    mockExecute([]);
    expect(await listConsoleChatThreads(WS, USER)).toEqual([]);
  });
});
