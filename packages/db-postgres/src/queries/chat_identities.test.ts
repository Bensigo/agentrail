import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq, gt, inArray } from "drizzle-orm";
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
  getChatIdentityById,
  bindChatIdentityWorkspace,
  bindChatIdentityUser,
  setChatIdentityLinkToken,
  getChatIdentityByLinkToken,
  consumeChatIdentityLinkToken,
  setChatIdentitySignupToken,
  consumeChatIdentitySignupToken,
  findChatIdentityBySignupToken,
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
  signupToken: null,
  signupTokenExpiresAt: null,
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

describe("getChatIdentityById", () => {
  it("returns the row for a matching id", async () => {
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getChatIdentityById("chat-identity-1");

    expect(result).toEqual(MOCK_IDENTITY);
    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(eq(chatIdentities.id, "chat-identity-1"))
    );
  });

  it("returns null when no identity matches the id", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await getChatIdentityById("unknown-id");

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

describe("consumeChatIdentityLinkToken", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("nulls link_token/link_token_expires_at and touches updatedAt, guarded by BOTH token equality and expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const consumedRow = {
      ...MOCK_IDENTITY,
      linkToken: null,
      linkTokenExpiresAt: null,
      updatedAt: NOW,
    };
    const updateChain = makeChain("returning", [consumedRow]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await consumeChatIdentityLinkToken("tok-abc");

    expect(mockDb.update).toHaveBeenCalled();

    // .set shape: both link columns nulled, updatedAt touched to the SAME
    // "now" the WHERE guard below is checked against (one shared clock read,
    // matching the claimInvitesForUser/resolveApproval idiom elsewhere in
    // this package).
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]).toEqual({
      linkToken: null,
      linkTokenExpiresAt: null,
      updatedAt: NOW,
    });

    // Argument-level condition assertion (see jace_sessions-intro-anchor.test.ts
    // for the rationale): render the ACTUAL captured `.where(...)` argument
    // and compare it to the literal SQL text of the guard this call must
    // encode. A mutation that drops the expiry half of the `and(...)` (e.g.
    // collapsing WHERE to bare `link_token = $token`, which would let an
    // EXPIRED token still be consumed) changes the rendered text and fails
    // this comparison, even though the mocked `.returning()` value above
    // would stay green regardless.
    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(chatIdentities.linkToken, "tok-abc"),
          gt(chatIdentities.linkTokenExpiresAt, NOW)
        )
      )
    );

    expect(result).toEqual(consumedRow);
  });

  it("returns null when the UPDATE matches no row (expired, already-used, or unknown token — indistinguishable by design)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await consumeChatIdentityLinkToken("expired-or-unknown-token");

    expect(result).toBeNull();
  });
});

describe("setChatIdentitySignupToken", () => {
  it("sets signupToken, signupTokenExpiresAt, and touches updatedAt for the given identity id", async () => {
    const updateChain = makeChain("where", undefined);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);
    const expiresAt = new Date("2026-08-01T00:00:00Z");

    await setChatIdentitySignupToken("chat-identity-1", "signup-tok-abc", expiresAt);

    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]?.signupToken).toBe("signup-tok-abc");
    expect(setCalls[0]?.[0]?.signupTokenExpiresAt).toBe(expiresAt);
    expect(setCalls[0]?.[0]?.updatedAt).toBeInstanceOf(Date);
    expect(updateChain.where).toHaveBeenCalled();
  });
});

describe("consumeChatIdentitySignupToken", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("nulls signup_token/signup_token_expires_at and touches updatedAt, guarded by BOTH token equality and expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const consumedRow = {
      ...MOCK_IDENTITY,
      signupToken: null,
      signupTokenExpiresAt: null,
      updatedAt: NOW,
    };
    const updateChain = makeChain("returning", [consumedRow]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await consumeChatIdentitySignupToken("signup-tok-abc");

    expect(mockDb.update).toHaveBeenCalled();

    // .set shape: both signup columns nulled, updatedAt touched to the SAME
    // "now" the WHERE guard below is checked against — same one-clock-read
    // idiom as consumeChatIdentityLinkToken above.
    const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls[0]?.[0]).toEqual({
      signupToken: null,
      signupTokenExpiresAt: null,
      updatedAt: NOW,
    });

    // Argument-level condition assertion (see consumeChatIdentityLinkToken's
    // own test above for the rationale): a mutation that drops the expiry
    // half of the `and(...)` — letting an EXPIRED signup token still be
    // consumed (AC3) — changes the rendered SQL text and fails this
    // comparison even though the mocked `.returning()` value would stay
    // green regardless.
    const whereArgs = (updateChain.where as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(chatIdentities.signupToken, "signup-tok-abc"),
          gt(chatIdentities.signupTokenExpiresAt, NOW)
        )
      )
    );

    expect(result).toEqual(consumedRow);
  });

  it("returns null when the UPDATE matches no row (expired, already-used, or unknown token — indistinguishable by design, AC3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const updateChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await consumeChatIdentitySignupToken("expired-or-unknown-signup-token");

    expect(result).toBeNull();
  });

  it("a SECOND concurrent consume of the same token gets null — single-use even under a race (AC3): the WHERE clause only matches the row while the token column is still non-null, and this update already nulled it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // First caller: UPDATE matches the row (token still set), returns it.
    const firstChain = makeChain("returning", [
      { ...MOCK_IDENTITY, signupToken: null, signupTokenExpiresAt: null, updatedAt: NOW },
    ]);
    mockDb.update = vi.fn(() => firstChain as ReturnType<typeof db.update>);
    const first = await consumeChatIdentitySignupToken("race-tok");
    expect(first).not.toBeNull();

    // Second (concurrent) caller: same token, but the column is already null
    // in the real DB by the time this WHERE evaluates — modeled here by the
    // second UPDATE's own WHERE simply matching zero rows.
    const secondChain = makeChain("returning", []);
    mockDb.update = vi.fn(() => secondChain as ReturnType<typeof db.update>);
    const second = await consumeChatIdentitySignupToken("race-tok");
    expect(second).toBeNull();
  });
});

describe("findChatIdentityBySignupToken (anti-unfurl fix, issue #1364)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("READ-ONLY: never touches db.update — a bare lookup can never consume the token", async () => {
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    const updateSpy = vi.fn();
    mockDb.update = updateSpy as unknown as typeof db.update;

    await findChatIdentityBySignupToken("tok-abc");

    expect(mockDb.select).toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns the row for a matching, unexpired token, guarded by BOTH token equality and expiry (same guard shape as the atomic consume)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await findChatIdentityBySignupToken("tok-abc");

    expect(result).toEqual(MOCK_IDENTITY);
    const whereArgs = (selectChain.where as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(renderCondition(whereArgs)).toEqual(
      renderCondition(
        and(
          eq(chatIdentities.signupToken, "tok-abc"),
          gt(chatIdentities.signupTokenExpiresAt, NOW)
        )
      )
    );
  });

  it("returns null for an expired token — never renders the form for a link that's already dead", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await findChatIdentityBySignupToken("expired-token");

    expect(result).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const selectChain = makeChain("limit", []);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await findChatIdentityBySignupToken("never-existed");

    expect(result).toBeNull();
  });

  it("ANTI-UNFURL REGRESSION: repeated non-consuming lookups (simulating link-preview bots hitting the page's GET) never disturb a token that a subsequent atomic consume can still redeem", async () => {
    // Three "unfurl bot" reads in a row, all read-only.
    const selectChain = makeChain("limit", [MOCK_IDENTITY]);
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);
    await findChatIdentityBySignupToken("tok-survives-unfurl");
    await findChatIdentityBySignupToken("tok-survives-unfurl");
    await findChatIdentityBySignupToken("tok-survives-unfurl");
    expect(mockDb.update).not.toHaveBeenCalled();

    // THEN the human clicks: the real atomic consume still succeeds, because
    // none of the reads above ever touched the token columns.
    const updateChain = makeChain("returning", [
      { ...MOCK_IDENTITY, signupToken: null, signupTokenExpiresAt: null },
    ]);
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);
    const consumed = await consumeChatIdentitySignupToken("tok-survives-unfurl");

    expect(consumed).not.toBeNull();
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
