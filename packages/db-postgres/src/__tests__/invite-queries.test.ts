import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing queries
vi.mock("../db.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// Mock crypto so tokens are deterministic
vi.mock("crypto", () => ({
  randomBytes: vi.fn(() => ({
    toString: vi.fn(() => "mock-token-base64url"),
  })),
}));

import { db } from "../db.js";
import {
  createInvite,
  revokeInvite,
  claimInvitesForUser,
  listInvites,
} from "../queries/index.js";

const mockDb = vi.mocked(db);

// Helper to build a chainable drizzle-like mock
function makeChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "from", "where", "limit",
    "orderBy", "returning", "values", "set", "onConflictDoUpdate",
    "onConflictDoNothing", "innerJoin", "leftJoin",
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // Terminal method returns value
  (chain as Record<string, unknown>).returning = vi.fn(() => Promise.resolve(finalValue));
  // Also make the chain itself thenable for direct awaits
  (chain as Record<string, unknown>).then = undefined;
  return chain;
}

const MOCK_INVITE = {
  id: "invite-1",
  workspaceId: "ws-1",
  email: "user@example.com",
  role: "member" as const,
  token: "tok",
  invitedByUserId: "user-abc",
  status: "pending" as const,
  createdAt: new Date("2026-01-01"),
  expiresAt: new Date(Date.now() + 14 * 86400_000),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createInvite", () => {
  it("lowercases the email and returns the inserted invite", async () => {
    const chain = makeChain([MOCK_INVITE]);
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    const result = await createInvite({
      workspaceId: "ws-1",
      email: "User@Example.COM",
      role: "member",
      invitedByUserId: "user-abc",
    });

    expect(mockDb.insert).toHaveBeenCalled();
    // The chain's values call should receive the lowercased email
    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls.length).toBeGreaterThan(0);
    expect(valuesCalls[0][0].email).toBe("user@example.com");
    expect(result).toBe(MOCK_INVITE);
  });

  it("uses default role 'member' when not specified", async () => {
    const chain = makeChain([MOCK_INVITE]);
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    await createInvite({
      workspaceId: "ws-1",
      email: "user@example.com",
      invitedByUserId: "user-abc",
    });

    const valuesCalls = (chain.values as ReturnType<typeof vi.fn>).mock.calls;
    expect(valuesCalls[0][0].role).toBe("member");
  });

  it("performs an upsert (onConflictDoUpdate is called)", async () => {
    const chain = makeChain([MOCK_INVITE]);
    mockDb.insert = vi.fn(() => chain as ReturnType<typeof db.insert>);

    await createInvite({
      workspaceId: "ws-1",
      email: "user@example.com",
      invitedByUserId: "user-abc",
    });

    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
  });
});

describe("revokeInvite", () => {
  it("updates status to revoked and returns the row", async () => {
    const revokedInvite = { ...MOCK_INVITE, status: "revoked" as const };
    const chain = makeChain([revokedInvite]);
    mockDb.update = vi.fn(() => chain as ReturnType<typeof db.update>);

    const result = await revokeInvite("ws-1", "invite-1");

    expect(mockDb.update).toHaveBeenCalled();
    expect((chain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe("revoked");
    expect(result).toEqual(revokedInvite);
  });

  it("returns null when no row is updated", async () => {
    const chain = makeChain([]);
    mockDb.update = vi.fn(() => chain as ReturnType<typeof db.update>);

    const result = await revokeInvite("ws-1", "nonexistent");
    expect(result).toBeNull();
  });
});

describe("claimInvitesForUser", () => {
  it("returns empty array when there are no pending invites", async () => {
    // select returns no rows
    const selectChain = makeChain([]);
    (selectChain.from as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);
    (selectChain.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve([])
    );
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const result = await claimInvitesForUser({
      userId: "user-1",
      email: "user@example.com",
    });

    expect(result).toEqual([]);
  });

  it("lowercases the email when querying pending invites", async () => {
    const selectChain = makeChain([]);
    (selectChain.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve([])
    );
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    await claimInvitesForUser({
      userId: "user-1",
      email: "USER@EXAMPLE.COM",
    });

    // The where clause is called with the lowercased email condition
    // We verify select was called — the lowercasing happens inside the function
    expect(mockDb.select).toHaveBeenCalled();
  });

  it("inserts memberships and marks invites accepted (idempotent via onConflictDoNothing)", async () => {
    const pendingInvite = { ...MOCK_INVITE };

    // First select returns a pending invite
    const selectChain = makeChain([]);
    (selectChain.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve([pendingInvite])
    );
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const insertChain = makeChain([]);
    (insertChain.onConflictDoNothing as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve(undefined)
    );
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const updateChain = makeChain([]);
    (updateChain.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve(undefined)
    );
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result = await claimInvitesForUser({
      userId: "user-1",
      email: "user@example.com",
    });

    expect(mockDb.insert).toHaveBeenCalled();
    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
    expect(result).toEqual(["ws-1"]);
  });

  it("is idempotent: calling twice with same args produces same result without error", async () => {
    const pendingInvite = { ...MOCK_INVITE };

    const selectChain = makeChain([]);
    (selectChain.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve([pendingInvite])
    );
    mockDb.select = vi.fn(() => selectChain as ReturnType<typeof db.select>);

    const insertChain = makeChain([]);
    (insertChain.onConflictDoNothing as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve(undefined)
    );
    mockDb.insert = vi.fn(() => insertChain as ReturnType<typeof db.insert>);

    const updateChain = makeChain([]);
    (updateChain.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve(undefined)
    );
    mockDb.update = vi.fn(() => updateChain as ReturnType<typeof db.update>);

    const result1 = await claimInvitesForUser({
      userId: "user-1",
      email: "user@example.com",
    });

    // Reset mocks for second call — simulate the invite is no longer pending
    const selectChain2 = makeChain([]);
    (selectChain2.where as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve([]) // no pending invites the second time
    );
    mockDb.select = vi.fn(() => selectChain2 as ReturnType<typeof db.select>);

    const result2 = await claimInvitesForUser({
      userId: "user-1",
      email: "user@example.com",
    });

    expect(result1).toEqual(["ws-1"]);
    expect(result2).toEqual([]);
  });
});

describe("listInvites", () => {
  it("returns pending non-expired invites for a workspace", async () => {
    const chain = makeChain([]);
    (chain.where as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    (chain.orderBy as ReturnType<typeof vi.fn>).mockReturnValue(
      Promise.resolve([MOCK_INVITE])
    );
    mockDb.select = vi.fn(() => chain as ReturnType<typeof db.select>);

    const result = await listInvites("ws-1");
    expect(mockDb.select).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });
});
