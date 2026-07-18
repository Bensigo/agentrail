import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull, or } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

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
import { jaceSessions } from "../schema/jace_sessions.js";
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

// --- argument-level condition assertions -----------------------------------
//
// A mock chain proves a method was *called*, but not what it was called
// *with* — a captured `.where(...)`/`onConflictDoNothing(...)` argument is a
// drizzle SQL condition tree (Column/Param/StringChunk nodes), not a plain
// object, so a naive `toEqual` against a hand-built plain object would pass
// or fail for the wrong reasons. Instead we render BOTH the actual captured
// condition and an expected condition — built in the test with the same
// drizzle operators (and/or/eq/isNull) against the real `jaceSessions`
// columns — to the literal {sql, params} text a real Postgres connection
// would receive (via the same `PgDialect.sqlToQuery` the implementer used to
// empirically verify the onConflict arbiter choice), and compare THAT. Two
// conditions with the same rendered SQL text and params are provably the same
// predicate; if the guard is weakened or a conflict-target column is swapped,
// the rendered text changes and the comparison fails.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
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
    // Conflict target must be the partial index's EXACT columns, in order —
    // not just "some 2-element array". Column-identity-checked (`toBe`
    // against the real schema column objects), not shape-checked: swapping
    // either column for a different one (e.g. workspace_id) fails this.
    const conflictArgs = (
      insertChain.onConflictDoNothing as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    expect(conflictArgs?.target).toHaveLength(2);
    expect(conflictArgs?.target?.[0]).toBe(jaceSessions.channel);
    expect(conflictArgs?.target?.[1]).toBe(jaceSessions.conversationKey);
    // The arbiter's WHERE predicate must be exactly the partial index's own
    // predicate (`workspace_id IS NULL`) so Postgres can infer this index as
    // the arbiter. Rendered to literal SQL since the captured object is a
    // freshly-built SQL tree each call, not reference-comparable.
    expect(renderCondition(conflictArgs?.where)).toEqual(
      renderCondition(isNull(jaceSessions.workspaceId))
    );

    // The follow-up SELECT must be scoped to `workspace_id IS NULL` in
    // addition to (channel, conversationKey) — without it, a second identity
    // racing a workspace-anchored session with the same (channel,
    // conversation_key) could resolve to the WRONG (tenant) row.
    const selectWhereArgs = (selectChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(selectWhereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.channel, "telegram"),
          eq(jaceSessions.conversationKey, "tg-chat-42"),
          isNull(jaceSessions.workspaceId)
        )
      )
    );

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
    // The mock's canned `result` above proves nothing about *which* rows the
    // real UPDATE would touch: the mock returns the same canned row no
    // matter what predicate was passed in. Render the ACTUAL captured
    // `.where(...)` argument and compare it to the guard this call must
    // encode — `id = sessionId AND (workspace_id IS NULL OR workspace_id =
    // workspaceId)` — so deleting the `or(isNull...)` guard (collapsing WHERE
    // to bare `id = sessionId`, which would let this call silently overwrite
    // ANY workspace) is caught here even though the mocked boolean result
    // above would stay green.
    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.id, "session-intro-1"),
          or(
            isNull(jaceSessions.workspaceId),
            eq(jaceSessions.workspaceId, "ws-1")
          )
        )
      )
    );
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
    // Same argument-level proof as above, for this call's own
    // sessionId/workspaceId — the guard is what makes "false" meaningful
    // (excludes a differently-owned row) rather than an artifact of the mock.
    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.id, "session-bound-elsewhere"),
          or(
            isNull(jaceSessions.workspaceId),
            eq(jaceSessions.workspaceId, "ws-2")
          )
        )
      )
    );
  });

  it("returns true (idempotent no-op) when the session already has the same workspace", async () => {
    // Same target workspace still satisfies the WHERE guard, so the row
    // matches and the update (a harmless no-op) proceeds.
    const updateChain = makeChain("returning", [{ id: "session-already-ws1" }]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await bindJaceSessionWorkspace("session-already-ws1", "ws-1");

    expect(result).toBe(true);
    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(jaceSessions.id, "session-already-ws1"),
          or(
            isNull(jaceSessions.workspaceId),
            eq(jaceSessions.workspaceId, "ws-1")
          )
        )
      )
    );
  });
});
