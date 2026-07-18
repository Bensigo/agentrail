import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Covers getJaceSessionById (issue #1273 review fix): the read behind the
// Telegram webhook's null-chatIdentityId SENDER CHECK fallback, which needs
// the owning session's conversationKey off `jaceApprovals.sessionId`.
//
// Mocked db chain: same "mock the chain, control the terminal value"
// approach as jace_sessions-approval-callback-token.test.ts /
// jace_sessions-connect-link.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import { getJaceSessionById } from "./jace_sessions.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "limit"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Argument-level condition assertions (see jace_sessions-connect-link.test.ts /
// jace_sessions-intro-anchor.test.ts for the full rationale): a mock chain
// proves a method was *called*, not what it was called *with* — render both
// the actual captured `.where(...)` condition and an expected one (built with
// the same drizzle operators against the real `jaceSessions` columns) to
// literal {sql, params} text via PgDialect.sqlToQuery and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");

const MOCK_SESSION = {
  id: "session-1",
  workspaceId: null,
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "555",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getJaceSessionById", () => {
  it("looks up by primary key id alone and returns the row", async () => {
    const selectChain = makeChain("limit", [MOCK_SESSION]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getJaceSessionById("session-1");

    expect(result).toEqual(MOCK_SESSION);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    // The key behavioral property this read leans on: a bare eq(id, ...)
    // condition, no workspace/identity scoping — the id itself is the
    // security boundary (mirrors getApprovalById's own rationale).
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(jaceSessions.id, "session-1"))
    );
  });

  it("returns null when no session has this id", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getJaceSessionById("unknown-id");

    expect(result).toBeNull();
  });
});
