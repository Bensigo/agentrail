import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Mocked db chain: each db.<verb>() call returns a chainable mock object
// where every intermediate method returns the same chain (so any call order
// works) and a terminal method resolves a value the test controls — same
// "mock the chain, control the terminal value" approach as
// jace_sessions-pending-approvals.test.ts, generalized (as in
// __tests__/invite-queries.test.ts) to also cover insert/update assertions.
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from "../db.js";
import { chatIdentities } from "../schema/chat_identities.js";
import { workspaceMemberships } from "../schema/workspace_memberships.js";
import { workspaces } from "../schema/workspaces.js";
import {
  insertChatIdentity,
  getChatIdentity,
  bindChatIdentityWorkspace,
  bindChatIdentityUser,
  setChatIdentityLinkToken,
  getChatIdentityByLinkToken,
  resolveInboundChatIdentity,
  listWorkspacesForChatIdentity,
} from "./chat_identities.js";

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
    "leftJoin",
    "orderBy",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}

// Argument-level condition assertions (see jace_sessions-intro-anchor.test.ts
// for the full rationale): render both the actual captured `.where`/join
// condition and an expected one — built with the same drizzle operators
// against the real schema columns — to literal {sql, params} text via
// PgDialect.sqlToQuery, and compare THAT rather than the call-presence alone.
const dialect = new PgDialect();
function renderCondition(condition: unknown) {
  return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
}

const NOW = new Date("2026-07-18T00:00:00Z");

const MOCK_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: null,
  workspaceId: null,
  linkToken: null,
  linkTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("insertChatIdentity", () => {
  it("inserts the given platform/platformUserId/displayName and returns the row via the post-insert lookup", async () => {
    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await insertChatIdentity("telegram", "tg-123", "Ada");

    expect(mockDb.insert).toHaveBeenCalled();
    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls[0]?.[0]).toEqual({
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Ada",
    });
    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    expect(result).toEqual(MOCK_IDENTITY);
  });

  it("defaults displayName to null when omitted", async () => {
    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await insertChatIdentity("telegram", "tg-123");

    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls[0]?.[0]?.displayName).toBeNull();
  });

  it("throws a prefixed error when the post-insert lookup finds no row (unreachable in practice)", async () => {
    const insertChain = makeChain("onConflictDoNothing", undefined);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await expect(insertChatIdentity("telegram", "tg-123")).rejects.toThrow(
      /insertChatIdentity: no row found for telegram\/tg-123/
    );
  });
});

describe("getChatIdentity", () => {
  it("returns the row for a matching (platform, platformUserId)", async () => {
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getChatIdentity("telegram", "tg-123");

    expect(result).toEqual(MOCK_IDENTITY);
  });

  it("returns null when no identity matches", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getChatIdentity("telegram", "unknown-user");

    expect(result).toBeNull();
  });
});

describe("bindChatIdentityWorkspace", () => {
  it("sets workspaceId and touches updatedAt for the given identity id", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await bindChatIdentityWorkspace("chat-identity-1", "ws-1");

    expect(mockDb.update).toHaveBeenCalled();
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.workspaceId).toBe("ws-1");
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    expect(updateChain.where).toHaveBeenCalled();
  });
});

describe("bindChatIdentityUser", () => {
  it("sets userId and touches updatedAt for the given identity id", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    await bindChatIdentityUser("chat-identity-1", "user-1");

    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.userId).toBe("user-1");
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    expect(updateChain.where).toHaveBeenCalled();
  });
});

describe("setChatIdentityLinkToken", () => {
  it("sets linkToken, linkTokenExpiresAt, and touches updatedAt for the given identity id", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);
    const expiresAt = new Date("2026-08-01T00:00:00Z");

    await setChatIdentityLinkToken("chat-identity-1", "tok-abc", expiresAt);

    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.linkToken).toBe("tok-abc");
    expect(setCalls[0]?.[0]?.linkTokenExpiresAt).toBe(expiresAt);
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    expect(updateChain.where).toHaveBeenCalled();
  });
});

describe("getChatIdentityByLinkToken", () => {
  it("returns the row for a matching link token", async () => {
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getChatIdentityByLinkToken("tok-abc");

    expect(result).toEqual(MOCK_IDENTITY);
  });

  it("returns null when no identity matches the token", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getChatIdentityByLinkToken("nonexistent-token");

    expect(result).toBeNull();
  });
});

describe("resolveInboundChatIdentity", () => {
  it("creates a new identity on first contact: created=true, disposition='intro'", async () => {
    const newRow = {
      ...MOCK_IDENTITY,
      id: "chat-identity-new",
      displayName: "Ada",
      workspaceId: null,
    };
    const insertChain = makeChain("returning", [newRow]);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const result = await resolveInboundChatIdentity({
      platform: "telegram",
      platformUserId: "tg-999",
      displayName: "Ada",
    });

    expect(mockDb.insert).toHaveBeenCalled();
    const valuesCalls = (insertChain.values as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(valuesCalls[0]?.[0]).toEqual({
      platform: "telegram",
      platformUserId: "tg-999",
      displayName: "Ada",
    });
    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    // The fast path (this call won the insert) must never issue a redundant
    // lookup or a self-refresh update.
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      identity: newRow,
      created: true,
      disposition: "intro",
    });
  });

  it("returns disposition 'bound' when the resolved identity already has a workspace_id", async () => {
    const insertChain = makeChain("returning", []); // lost the race
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const boundIdentity = { ...MOCK_IDENTITY, workspaceId: "ws-1" };
    const selectChain = makeChain("limit", [boundIdentity]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await resolveInboundChatIdentity({
      platform: "telegram",
      platformUserId: "tg-123",
    });

    expect(result.created).toBe(false);
    expect(result.disposition).toBe("bound");
    expect(result.identity).toEqual(boundIdentity);
  });

  it("refreshes display_name when provided and different from the stored value", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const existing = { ...MOCK_IDENTITY, displayName: "Old Name" };
    const selectChain = makeChain("limit", [existing]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    const updateChain = makeChain("returning", [
      { ...existing, displayName: "New Name" },
    ]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await resolveInboundChatIdentity({
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "New Name",
    });

    expect(mockDb.update).toHaveBeenCalled();
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.displayName).toBe("New Name");
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    expect(result.identity.displayName).toBe("New Name");
    expect(result.created).toBe(false);
  });

  it("does not update when displayName is provided but matches the stored value", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const existing = { ...MOCK_IDENTITY, displayName: "Same Name" };
    const selectChain = makeChain("limit", [existing]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await resolveInboundChatIdentity({
      platform: "telegram",
      platformUserId: "tg-123",
      displayName: "Same Name",
    });

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(result.identity).toEqual(existing);
  });

  it("does not update when displayName is omitted", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const existing = { ...MOCK_IDENTITY, displayName: "Whatever" };
    const selectChain = makeChain("limit", [existing]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await resolveInboundChatIdentity({
      platform: "telegram",
      platformUserId: "tg-123",
    });

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(result.identity).toEqual(existing);
  });

  it("throws a prefixed error when neither the insert nor the follow-up lookup finds a row (unreachable in practice)", async () => {
    const insertChain = makeChain("returning", []);
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await expect(
      resolveInboundChatIdentity({
        platform: "telegram",
        platformUserId: "tg-123",
      })
    ).rejects.toThrow(
      /resolveInboundChatIdentity: no row found for telegram\/tg-123/
    );
  });
});

describe("listWorkspacesForChatIdentity", () => {
  it("dedupes overlap between the own workspace_id binding and workspace_memberships", async () => {
    // Simulates: identity bound to ws-1, and its linked user is ALSO a member
    // of ws-1 (overlap) and ws-2 (distinct) — the LEFT JOIN emits one row per
    // membership match, so ws-1 appears twice in the raw rows.
    const joinChain = makeChain("where", [
      { ownWorkspaceId: "ws-1", membershipWorkspaceId: "ws-1" },
      { ownWorkspaceId: "ws-1", membershipWorkspaceId: "ws-2" },
    ]);
    const workspacesChain = makeChain("orderBy", [
      { id: "ws-2", name: "Alpha" },
      { id: "ws-1", name: "Beta" },
    ]);
    mockDb.select = vi
      .fn()
      .mockReturnValueOnce(joinChain as ReturnType<typeof db.select>)
      .mockReturnValueOnce(workspacesChain as ReturnType<typeof db.select>);

    const result = await listWorkspacesForChatIdentity("chat-identity-1");

    // First query: chatIdentities LEFT JOIN workspaceMemberships on
    // membership.userId = identity.userId, filtered to this one identity.
    const joinArgs = (joinChain.leftJoin as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(joinArgs?.[0]).toBe(workspaceMemberships);
    expect(renderCondition(joinArgs?.[1])).toEqual(
      renderCondition(eq(workspaceMemberships.userId, chatIdentities.userId))
    );
    const joinWhereArgs = (joinChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(joinWhereArgs)).toEqual(
      renderCondition(eq(chatIdentities.id, "chat-identity-1"))
    );

    // Second query: deduped ids passed to inArray, in first-seen order.
    const wsWhereArgs = (workspacesChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(wsWhereArgs)).toEqual(
      renderCondition(inArray(workspaces.id, ["ws-1", "ws-2"]))
    );

    expect(result).toEqual([
      { id: "ws-2", name: "Alpha" },
      { id: "ws-1", name: "Beta" },
    ]);
  });

  it("returns an empty array when the identity has neither a workspace_id binding nor any memberships", async () => {
    // LEFT JOIN still emits exactly one row for the identity itself, with
    // membershipWorkspaceId null (no matching membership row).
    const joinChain = makeChain("where", [
      { ownWorkspaceId: null, membershipWorkspaceId: null },
    ]);
    mockDb.select = vi.fn(() => joinChain as ReturnType<typeof db.select>);

    const result = await listWorkspacesForChatIdentity("chat-identity-2");

    expect(result).toEqual([]);
    // No workspace ids to look up — the second query must never fire.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array when no chat identity matches the given id", async () => {
    const joinChain = makeChain("where", []);
    mockDb.select = vi.fn(() => joinChain as ReturnType<typeof db.select>);

    const result = await listWorkspacesForChatIdentity("nonexistent-identity");

    expect(result).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("resolves the own workspace_id binding alone when the identity has no linked user", async () => {
    const joinChain = makeChain("where", [
      { ownWorkspaceId: "ws-1", membershipWorkspaceId: null },
    ]);
    const workspacesChain = makeChain("orderBy", [
      { id: "ws-1", name: "Beta" },
    ]);
    mockDb.select = vi
      .fn()
      .mockReturnValueOnce(joinChain as ReturnType<typeof db.select>)
      .mockReturnValueOnce(workspacesChain as ReturnType<typeof db.select>);

    const result = await listWorkspacesForChatIdentity("chat-identity-3");

    const wsWhereArgs = (workspacesChain.where as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(renderCondition(wsWhereArgs)).toEqual(
      renderCondition(inArray(workspaces.id, ["ws-1"]))
    );
    expect(result).toEqual([{ id: "ws-1", name: "Beta" }]);
  });
});
