import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain, same "mock the chain, control the terminal value" approach
// as jace_sessions-disambiguation.test.ts. `listWorkspacesForChatIdentity` is
// a cross-module call (chat_identities.js) — mocked at the module boundary
// rather than re-deriving its own internal query shape here, so these tests
// only exercise repinConversationWorkspace's OWN logic (the reach-both
// authority re-check, and the guarded UPDATE).
vi.mock("../db.js", () => ({
  db: {
    update: vi.fn(),
  },
}));

vi.mock("./chat_identities.js", () => ({
  listWorkspacesForChatIdentity: vi.fn(),
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import { listWorkspacesForChatIdentity } from "./chat_identities.js";
import { repinConversationWorkspace } from "./jace_sessions.js";

const mockDb = vi.mocked(db);
const mockListWorkspaces = vi.mocked(listWorkspacesForChatIdentity);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["where", "set"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// --- argument-level condition assertions -----------------------------------
// Same rationale as jace_sessions-disambiguation.test.ts: render both the
// actual captured condition and an expected one — built with the same
// drizzle operators against the real `jaceSessions` columns — to literal
// {sql, params} text via PgDialect.sqlToQuery, and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("repinConversationWorkspace", () => {
  it("refuses with not_reachable and performs no write when the identity does not reach fromWorkspaceId", async () => {
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-2", name: "Beta" }]);

    const result = await repinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      fromWorkspaceId: "ws-1",
      toWorkspaceId: "ws-2",
    });

    expect(result).toEqual({ ok: false, reason: "not_reachable" });
    expect(mockListWorkspaces).toHaveBeenCalledWith("chat-identity-1");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("refuses with not_reachable and performs no write when the identity does not reach toWorkspaceId", async () => {
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-1", name: "Acme" }]);

    const result = await repinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      fromWorkspaceId: "ws-1",
      toWorkspaceId: "ws-2",
    });

    expect(result).toEqual({ ok: false, reason: "not_reachable" });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("updates the row and returns ok + sessionId on the happy path", async () => {
    mockListWorkspaces.mockResolvedValueOnce([
      { id: "ws-1", name: "Acme" },
      { id: "ws-2", name: "Beta" },
    ]);
    const updateChain = makeChain("returning", [{ id: "session-1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await repinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      fromWorkspaceId: "ws-1",
      toWorkspaceId: "ws-2",
    });

    expect(result).toEqual({ ok: true, sessionId: "session-1" });
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.workspaceId).toBe("ws-2");
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns moved when the guarded UPDATE matches zero rows", async () => {
    mockListWorkspaces.mockResolvedValueOnce([
      { id: "ws-1", name: "Acme" },
      { id: "ws-2", name: "Beta" },
    ]);
    // A concurrent re-pin landed first: the guard (workspace_id = fromWorkspaceId)
    // no longer matches the row, so `.returning()` comes back empty.
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await repinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      fromWorkspaceId: "ws-1",
      toWorkspaceId: "ws-2",
    });

    expect(result).toEqual({ ok: false, reason: "moved" });
  });

  it("guards the UPDATE on the CURRENT workspace_id, not only on channel + conversationKey", async () => {
    // This is the case that matters most: without the workspace_id guard, a
    // concurrent re-pin that landed first would be silently clobbered rather
    // than surfaced as `moved`. Assert on the actual `where` clause the
    // mocked builder received.
    mockListWorkspaces.mockResolvedValueOnce([
      { id: "ws-1", name: "Acme" },
      { id: "ws-2", name: "Beta" },
    ]);
    const updateChain = makeChain("returning", [{ id: "session-1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await repinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      fromWorkspaceId: "ws-1",
      toWorkspaceId: "ws-2",
    });

    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.channel, "telegram"),
          eq(jaceSessions.conversationKey, "tg-chat-77"),
          eq(jaceSessions.workspaceId, "ws-1")
        )
      )
    );
  });
});
