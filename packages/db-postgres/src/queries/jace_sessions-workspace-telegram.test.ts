import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-connect-link.test.ts (this function's sibling,
// latestTelegramSessionForChatIdentity, lives right next to it).
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import { latestTelegramSessionForWorkspace } from "./jace_sessions.js";

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

// Argument-level condition assertions (see jace_sessions-intro-anchor.test.ts
// for the full rationale): render both the actual captured condition and an
// expected one — built with the same drizzle operators against the real
// `jaceSessions` columns — to literal {sql, params} text via
// PgDialect.sqlToQuery, and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");

const MOCK_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: null,
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("latestTelegramSessionForWorkspace", () => {
  it("scopes to (workspace_id, channel='telegram'), most-recently-active first", async () => {
    const selectChain = makeChain("limit", [MOCK_SESSION]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await latestTelegramSessionForWorkspace("ws-1");

    expect(result).toEqual(MOCK_SESSION);

    // Argument-level: a mutation that dropped the channel='telegram' half of
    // this condition (matching ANY channel) would still pass a naive
    // "returns a row" assertion but changes the rendered WHERE text, so it
    // is caught here.
    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.workspaceId, "ws-1"),
          eq(jaceSessions.channel, "telegram")
        )
      )
    );

    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(jaceSessions.lastActivityAt))
    );
  });

  it("returns null when the workspace has no telegram session", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await latestTelegramSessionForWorkspace("ws-no-sessions");

    expect(result).toBeNull();
  });
});
