import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain: same "mock the chain, control the terminal value"
// approach as chat_identities.test.ts / jace_sessions-intro-anchor.test.ts.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import {
  getJaceSessionByEveSessionId,
  latestTelegramSessionForChatIdentity,
} from "./jace_sessions.js";

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
// for the full rationale): a mock chain proves a method was *called*, not
// what it was called *with* — a captured `.where(...)`/`.orderBy(...)`
// argument is a drizzle SQL condition tree, not a plain object, so we render
// both the actual captured condition and an expected one (built with the
// same drizzle operators against the real `jaceSessions` columns) to literal
// {sql, params} text via PgDialect.sqlToQuery and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");

const MOCK_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
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

describe("getJaceSessionByEveSessionId", () => {
  it("looks up by eve_session_id, most-recently-active first, and returns the row", async () => {
    const selectChain = makeChain("limit", [MOCK_SESSION]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getJaceSessionByEveSessionId("eve-session-1");

    expect(result).toEqual(MOCK_SESSION);

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(jaceSessions.eveSessionId, "eve-session-1"))
    );

    // No unique constraint on eve_session_id — order by most-recently-active
    // so a hypothetical duplicate resolves the same way
    // resolveConversationWorkspace's own multi-row tie-break does.
    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(jaceSessions.lastActivityAt))
    );
  });

  it("returns null when no session has this eve_session_id bound", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getJaceSessionByEveSessionId("unknown-eve-session");

    expect(result).toBeNull();
  });
});

describe("latestTelegramSessionForChatIdentity", () => {
  it("scopes to (chat_identity_id, channel='telegram'), most-recently-active first", async () => {
    const selectChain = makeChain("limit", [MOCK_SESSION]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await latestTelegramSessionForChatIdentity(
      "chat-identity-1"
    );

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
          eq(jaceSessions.chatIdentityId, "chat-identity-1"),
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

  it("returns null when the identity has no telegram session", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await latestTelegramSessionForChatIdentity(
      "chat-identity-no-sessions"
    );

    expect(result).toBeNull();
  });
});
