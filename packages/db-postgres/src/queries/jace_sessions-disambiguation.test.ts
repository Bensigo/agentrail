import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain, same "mock the chain, control the terminal value"
// approach as jace_sessions-intro-anchor.test.ts. `listWorkspacesForChatIdentity`
// is a cross-module call (chat_identities.js) — mocked at the module boundary
// rather than re-deriving its own internal query shape here, so these tests
// only exercise resolveConversationWorkspace/pinConversationWorkspace's OWN
// logic (precedence, session lookups, the reachability guard) while the
// same-module calls they make (bindJaceSessionWorkspace, getOrCreateJaceSession)
// still run for real against the mocked db, proving the wiring between them.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("./chat_identities.js", () => ({
  listWorkspacesForChatIdentity: vi.fn(),
}));

import { db } from "../db.js";
import { jaceSessions } from "../schema/jace_sessions.js";
import { listWorkspacesForChatIdentity } from "./chat_identities.js";
import {
  resolveConversationWorkspace,
  pinConversationWorkspace,
} from "./jace_sessions.js";

const mockDb = vi.mocked(db);
const mockListWorkspaces = vi.mocked(listWorkspacesForChatIdentity);

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
    "orderBy",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// --- argument-level condition assertions -----------------------------------
// Same rationale as jace_sessions-intro-anchor.test.ts: render both the
// actual captured condition and an expected one — built with the same
// drizzle operators against the real `jaceSessions` columns — to literal
// {sql, params} text via PgDialect.sqlToQuery, and compare THAT.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");
const EARLIER = new Date("2026-07-17T00:00:00Z");

const PINNED_SESSION_WS1 = {
  id: "session-ws1",
  workspaceId: "ws-1",
  chatIdentityId: null,
  channel: "telegram",
  conversationKey: "tg-chat-77",
  eveSessionId: "eve-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: EARLIER,
  updatedAt: NOW,
};

const OLDER_PINNED_SESSION_WS2 = {
  ...PINNED_SESSION_WS1,
  id: "session-ws2",
  workspaceId: "ws-2",
  lastActivityAt: EARLIER,
};

const INTRO_SESSION = {
  id: "session-intro-1",
  workspaceId: null,
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-77",
  eveSessionId: null,
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const FRESH_SESSION = {
  id: "session-fresh-1",
  workspaceId: "ws-1",
  chatIdentityId: null,
  channel: "telegram",
  conversationKey: "tg-chat-77",
  eveSessionId: null,
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveConversationWorkspace", () => {
  it("returns kind 'pinned' with ambiguous:false for a single workspace-anchored session, and never consults listWorkspacesForChatIdentity", async () => {
    const selectChain = makeChain("orderBy", [PINNED_SESSION_WS1]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await resolveConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
    });

    expect(result).toEqual({
      kind: "pinned",
      workspaceId: "ws-1",
      sessionId: "session-ws1",
      ambiguous: false,
    });
    expect(mockListWorkspaces).not.toHaveBeenCalled();

    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.channel, "telegram"),
          eq(jaceSessions.conversationKey, "tg-chat-77"),
          isNotNull(jaceSessions.workspaceId)
        )
      )
    );
    const orderByArgs = (selectChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(jaceSessions.lastActivityAt))
    );
  });

  it("returns kind 'pinned' with ambiguous:true and the most-recently-active session when 2+ workspace-anchored sessions share the conversation key", async () => {
    // Rows arrive pre-sorted desc by lastActivityAt, exactly as the real
    // ORDER BY would return them — the function must trust that order and
    // take the first row, not re-sort in application code.
    const selectChain = makeChain("orderBy", [
      PINNED_SESSION_WS1,
      OLDER_PINNED_SESSION_WS2,
    ]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await resolveConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
    });

    expect(result).toEqual({
      kind: "pinned",
      workspaceId: "ws-1",
      sessionId: "session-ws1",
      ambiguous: true,
    });
  });

  it("returns kind 'ask' with the reachable options when no pinned session exists and 2+ workspaces are reachable", async () => {
    const selectChain = makeChain("orderBy", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    mockListWorkspaces.mockResolvedValueOnce([
      { id: "ws-1", name: "Acme" },
      { id: "ws-2", name: "Beta" },
    ]);

    const result = await resolveConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
    });

    expect(result).toEqual({
      kind: "ask",
      options: [
        { id: "ws-1", name: "Acme" },
        { id: "ws-2", name: "Beta" },
      ],
    });
    expect(mockListWorkspaces).toHaveBeenCalledWith("chat-identity-1");
  });

  it("returns kind 'single' when no pinned session exists and exactly 1 workspace is reachable", async () => {
    const selectChain = makeChain("orderBy", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-1", name: "Acme" }]);

    const result = await resolveConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
    });

    expect(result).toEqual({ kind: "single", workspaceId: "ws-1" });
  });

  it("returns kind 'intro' when no pinned session exists and 0 workspaces are reachable", async () => {
    const selectChain = makeChain("orderBy", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    mockListWorkspaces.mockResolvedValueOnce([]);

    const result = await resolveConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
    });

    expect(result).toEqual({ kind: "intro" });
  });
});

describe("pinConversationWorkspace", () => {
  it("returns not_reachable and performs no db call at all when workspaceId is not in the identity's reachable set", async () => {
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-other", name: "Other" }]);

    const result = await pinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      workspaceId: "ws-not-reachable",
    });

    expect(result).toEqual({ ok: false, reason: "not_reachable" });
    expect(mockListWorkspaces).toHaveBeenCalledWith("chat-identity-1");
    // The tenant-isolation guard runs BEFORE any write — and before this
    // function even looks up an intro session, so no `db` call fires at all.
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("graduates an existing intro session via bindJaceSessionWorkspace's atomic guard when one exists for the conversation", async () => {
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-1", name: "Acme" }]);
    const lookupChain = makeChain("limit", [INTRO_SESSION]);
    mockDb.select = vi.fn(() => lookupChain as ReturnType<typeof db.select>);
    const updateChain = makeChain("returning", [{ id: INTRO_SESSION.id }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await pinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ ok: true, sessionId: "session-intro-1" });
    expect(mockDb.insert).not.toHaveBeenCalled();

    // The lookup is NOT scoped to `workspace_id IS NULL` — it finds ANY
    // existing session (intro or already-anchored) for this conversation,
    // most-recently-active first, so a re-pin attempt on an already-pinned
    // conversation and a race on an intro session both flow through the
    // same bindJaceSessionWorkspace guard below.
    const lookupWhereArgs = (lookupChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(lookupWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.channel, "telegram"),
          eq(jaceSessions.conversationKey, "tg-chat-77")
        )
      )
    );
    const orderByArgs = (lookupChain.orderBy as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(orderByArgs)).toEqual(
      renderCondition(desc(jaceSessions.lastActivityAt))
    );

    // bindJaceSessionWorkspace's own where-guard (id = sessionId AND
    // (workspace_id IS NULL OR workspace_id = target)) — reused unmodified.
    const updateWhereArgs = (updateChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(updateWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.id, "session-intro-1"),
          or(isNull(jaceSessions.workspaceId), eq(jaceSessions.workspaceId, "ws-1"))
        )
      )
    );
  });

  it("returns already_pinned_elsewhere when the intro session graduated to a different workspace in a race", async () => {
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-1", name: "Acme" }]);
    const lookupChain = makeChain("limit", [INTRO_SESSION]);
    mockDb.select = vi.fn(() => lookupChain as ReturnType<typeof db.select>);
    // The guard excluded the row: `.returning()` comes back empty.
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await pinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ ok: false, reason: "already_pinned_elsewhere" });
  });

  it("returns already_pinned_elsewhere on a straightforward re-pin attempt (no race): the conversation already has a different workspace-anchored session", async () => {
    mockListWorkspaces.mockResolvedValueOnce([
      { id: "ws-1", name: "Acme" },
      { id: "ws-2", name: "Beta" },
    ]);
    // The most-recently-active session for this conversation is ALREADY
    // anchored to ws-1 (not an intro row, and no concurrency involved).
    const lookupChain = makeChain("limit", [PINNED_SESSION_WS1]);
    mockDb.select = vi.fn(() => lookupChain as ReturnType<typeof db.select>);
    // bindJaceSessionWorkspace's guard (workspace_id IS NULL OR = ws-2)
    // excludes a row already bound to ws-1: matches nothing.
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await pinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      workspaceId: "ws-2",
    });

    expect(result).toEqual({ ok: false, reason: "already_pinned_elsewhere" });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("creates a fresh workspace-anchored session and sets chat_identity_id when no session exists yet for the conversation", async () => {
    mockListWorkspaces.mockResolvedValueOnce([{ id: "ws-1", name: "Acme" }]);

    const lookupChain = makeChain("limit", []); // no existing session found
    const getOrCreateSelectChain = makeChain("limit", [FRESH_SESSION]);
    mockDb.select = vi
      .fn()
      .mockReturnValueOnce(lookupChain as ReturnType<typeof db.select>)
      .mockReturnValueOnce(getOrCreateSelectChain as ReturnType<typeof db.select>);

    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await pinConversationWorkspace({
      chatIdentityId: "chat-identity-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
      workspaceId: "ws-1",
    });

    expect(result).toEqual({ ok: true, sessionId: "session-fresh-1" });

    // getOrCreateJaceSession's own insert — reused unmodified.
    const insertValuesCalls = (insertChain.values as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(insertValuesCalls[0]?.[0]).toEqual({
      workspaceId: "ws-1",
      channel: "telegram",
      conversationKey: "tg-chat-77",
    });

    // The extra "keep the identity link" UPDATE this function adds on top —
    // scoped to `isNull(chatIdentityId)` so a same-workspace race can't let
    // the loser's UPDATE clobber the winner's identity link.
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.chatIdentityId).toBe("chat-identity-1");
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    const updateWhereArgs = (updateChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(updateWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.id, "session-fresh-1"),
          isNull(jaceSessions.chatIdentityId)
        )
      )
    );
  });
});
