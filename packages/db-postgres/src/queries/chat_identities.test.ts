import { describe, it, expect, vi, beforeEach } from "vitest";

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
import {
  insertChatIdentity,
  getChatIdentity,
  bindChatIdentityWorkspace,
  bindChatIdentityUser,
  setChatIdentityLinkToken,
  getChatIdentityByLinkToken,
} from "./chat_identities.js";

const mockDb = vi.mocked(db);

/** A chainable mock: every method returns the chain except `terminalMethod`, which resolves `finalValue`. */
function makeChain(terminalMethod: string, finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "where", "limit", "values", "set", "onConflictDoNothing"];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain[terminalMethod] = vi.fn(() => Promise.resolve(finalValue));
  return chain;
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
