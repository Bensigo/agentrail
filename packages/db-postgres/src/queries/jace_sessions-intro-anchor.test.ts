import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked db chain: same "mock the chain, control the terminal value"
// approach as chat_identities.test.ts, generalized here to cover the
// insert+select (getOrCreateIntroJaceSession) and conditional-update
// (bindJaceSessionWorkspace) shapes for the intro-anchor extension.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import {
  getOrCreateIntroJaceSession,
  bindJaceSessionWorkspace,
} from "./jace_sessions.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "from",
    "where",
    "limit",
    "values",
    "set",
    "onConflictDoNothing",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

const NOW = new Date("2026-07-18T00:00:00Z");

const MOCK_INTRO_SESSION = {
  id: "session-intro-1",
  workspaceId: null,
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: null,
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreateIntroJaceSession", () => {
  it("inserts anchored on chatIdentityId with the given channel/conversationKey, and returns the row via the post-insert lookup", async () => {
    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", [MOCK_INTRO_SESSION]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getOrCreateIntroJaceSession(
      "chat-identity-1",
      "telegram",
      "tg-chat-42"
    );

    expect(mockDb.insert).toHaveBeenCalled();
    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(valuesCalls[0]?.[0]).toEqual({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-42",
    });
    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    // Conflict target must be the partial index's columns (channel,
    // conversation_key), not the workspace-anchored composite unique.
    const conflictArgs = (
      insertChain.onConflictDoNothing as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(conflictArgs?.target).toHaveLength(2);
    expect(conflictArgs?.where).toBeDefined();
    expect(result).toEqual(MOCK_INTRO_SESSION);
  });

  it("returns the existing intro session on a second call for the same (channel, conversationKey)", async () => {
    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", [MOCK_INTRO_SESSION]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const first = await getOrCreateIntroJaceSession(
      "chat-identity-1",
      "telegram",
      "tg-chat-42"
    );
    const second = await getOrCreateIntroJaceSession(
      "chat-identity-1",
      "telegram",
      "tg-chat-42"
    );

    expect(first).toEqual(MOCK_INTRO_SESSION);
    expect(second).toEqual(MOCK_INTRO_SESSION);
  });

  it("throws a prefixed error when the post-insert lookup finds no row (unreachable in practice)", async () => {
    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await expect(
      getOrCreateIntroJaceSession("chat-identity-1", "telegram", "tg-chat-42")
    ).rejects.toThrow(
      /getOrCreateIntroJaceSession: no row found for chat-identity-1\/telegram\/tg-chat-42/
    );
  });
});

describe("bindJaceSessionWorkspace", () => {
  it("binds workspace_id and touches updatedAt when the session has no workspace yet", async () => {
    const updateChain = makeChain("returning", [{ id: "session-intro-1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await bindJaceSessionWorkspace("session-intro-1", "ws-1");

    expect(result).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.workspaceId).toBe("ws-1");
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    expect(updateChain.where).toHaveBeenCalled();
  });

  it("returns false and does not re-tenant when the session already has a different workspace", async () => {
    // The WHERE guard (workspace_id IS NULL OR workspace_id = $target)
    // excludes the row, so the UPDATE matches nothing.
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await bindJaceSessionWorkspace(
      "session-bound-elsewhere",
      "ws-2"
    );

    expect(result).toBe(false);
  });

  it("returns true (idempotent no-op) when the session already has the same workspace", async () => {
    // Same target workspace still satisfies the WHERE guard, so the row
    // matches and the update (a harmless no-op) proceeds.
    const updateChain = makeChain("returning", [{ id: "session-already-ws1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await bindJaceSessionWorkspace("session-already-ws1", "ws-1");

    expect(result).toBe(true);
  });
});
