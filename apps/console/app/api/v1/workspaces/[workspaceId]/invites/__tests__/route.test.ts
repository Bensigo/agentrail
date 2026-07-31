import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  db: {},
  getWorkspaceMembership: vi.fn(),
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  revokeInvite: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  removeWorkspaceMembership: vi.fn(),
  getBillingAccountIdForWorkspace: vi.fn(),
  listAccountWorkspaceIds: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  releaseUserSeatForAccount: vi.fn(),
  // Seat gate (subscription platform spec §6 point 1 / slice 5 Task 6) —
  // POST /invites' own active-seat count against the resolved policy's
  // seatLimit. Not wired to any default in beforeEach (unlike the runner/
  // channel-dispatch suites): every PRE-existing test in this file leaves
  // mockSubscriptionsEnforced unset, which vi.fn() defaults to returning
  // `undefined` — falsy — so the gate's `if (subscriptionsEnforced())`
  // short-circuits and every test below stays byte-identical without
  // needing an explicit off-default.
  countActiveSeats: vi.fn(),
}));
vi.mock("../../../../../../../lib/policy/resolve-policy", () => ({
  resolvePolicyForWorkspace: vi.fn(),
}));
vi.mock("../../../../../../../lib/policy/feature-flags", () => ({
  subscriptionsEnforced: vi.fn(),
}));

import { GET, POST } from "../route";
import { DELETE } from "../../invites/[inviteId]/route";
import { GET as getMembers } from "../../members/route";
import { DELETE as removeMember } from "../../members/[userId]/route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  createInvite,
  listInvites,
  revokeInvite,
  listWorkspaceMembers,
  removeWorkspaceMembership,
  getBillingAccountIdForWorkspace,
  listAccountWorkspaceIds,
  listWorkspacesForUser,
  releaseUserSeatForAccount,
  countActiveSeats,
} from "@agentrail/db-postgres";
import { resolvePolicyForWorkspace } from "../../../../../../../lib/policy/resolve-policy";
import { subscriptionsEnforced } from "../../../../../../../lib/policy/feature-flags";

const mockAuth = vi.mocked(auth);
const mockGetWorkspaceMembership = vi.mocked(getWorkspaceMembership);
const mockCreateInvite = vi.mocked(createInvite);
const mockListInvites = vi.mocked(listInvites);
const mockRevokeInvite = vi.mocked(revokeInvite);
const mockListWorkspaceMembers = vi.mocked(listWorkspaceMembers);
const mockRemoveWorkspaceMembership = vi.mocked(removeWorkspaceMembership);
const mockGetBillingAccountIdForWorkspace = vi.mocked(getBillingAccountIdForWorkspace);
const mockListAccountWorkspaceIds = vi.mocked(listAccountWorkspaceIds);
const mockListWorkspacesForUser = vi.mocked(listWorkspacesForUser);
const mockReleaseUserSeatForAccount = vi.mocked(releaseUserSeatForAccount);
const mockCountActiveSeats = vi.mocked(countActiveSeats);
const mockResolvePolicy = vi.mocked(resolvePolicyForWorkspace);
const mockSubscriptionsEnforced = vi.mocked(subscriptionsEnforced);

const VALID_SESSION = {
  user: { id: "user-123", name: "Test User", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const OWNER_MEMBERSHIP = {
  userId: "user-123",
  workspaceId: "ws-1",
  role: "owner" as const,
  createdAt: new Date(),
};
// The TARGET of the DELETE /members/[userId] tests below — a distinct
// user-456, kept separate from OWNER_MEMBERSHIP/MEMBER_MEMBERSHIP (which
// represent the CALLER, user-123) so the two getWorkspaceMembership calls
// in that route (caller, then target) can be mocked independently via
// mockResolvedValueOnce chaining.
const TARGET_MEMBER_MEMBERSHIP = {
  userId: "user-456",
  workspaceId: "ws-1",
  role: "member" as const,
  createdAt: new Date(),
};
const TARGET_OWNER_MEMBERSHIP = {
  userId: "user-456",
  workspaceId: "ws-1",
  role: "owner" as const,
  createdAt: new Date(),
};
const MEMBER_MEMBERSHIP = {
  userId: "user-123",
  workspaceId: "ws-1",
  role: "member" as const,
  createdAt: new Date(),
};

const MOCK_INVITE = {
  id: "invite-1",
  workspaceId: "ws-1",
  email: "invited@example.com",
  role: "member" as const,
  token: "tok123",
  invitedByUserId: "user-123",
  status: "pending" as const,
  createdAt: new Date("2026-01-01"),
  expiresAt: new Date(Date.now() + 14 * 86400_000),
};

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

const WORKSPACE_ID = "ws-1";
const PARAMS_WS = { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
const PARAMS_INVITE = {
  params: Promise.resolve({ workspaceId: WORKSPACE_ID, inviteId: "invite-1" }),
};
const PARAMS_MEMBER = {
  params: Promise.resolve({ workspaceId: WORKSPACE_ID, userId: "user-456" }),
};
// Self-removal: the path param's userId is the SAME as VALID_SESSION's
// caller (user-123) — used by the last-owner self-removal test.
const PARAMS_SELF = {
  params: Promise.resolve({ workspaceId: WORKSPACE_ID, userId: "user-123" }),
};

// ---- POST /invites ----

describe("POST /api/v1/workspaces/[workspaceId]/invites", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "x@y.com" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a workspace member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "x@y.com" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns 403 when caller is a member (not owner/admin)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(MEMBER_MEMBERSHIP);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "x@y.com" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns 400 when email is missing", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when email is invalid", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "not-an-email" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(400);
  });

  it("returns 400 when role is owner", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "x@y.com", role: "owner" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(400);
  });

  it("returns 201 with invite including token on success (upsert)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
    mockCreateInvite.mockResolvedValue(MOCK_INVITE);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "POST",
      { email: "invited@example.com" }
    );
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { id: string; token: string } };
    expect(body.invite.id).toBe("invite-1");
    expect(body.invite.token).toBe("tok123");
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({ email: "invited@example.com" })
    );
  });

  // ---- Seat gate (subscription platform spec §6 point 1 / slice 5 Task 6):
  // refuse a NEW invite (or a re-invite upsert of an existing pending one)
  // once the billing account is at its seat limit — see route.ts's own
  // doc-comment on the gate block for the full placement/fail-open/stub
  // rationale. ----

  describe("seat gate", () => {
    function enforcedAtSeats(seatLimit: number, activeSeats: number) {
      mockSubscriptionsEnforced.mockReturnValue(true);
      mockResolvePolicy.mockResolvedValue({
        policy: { seatLimit } as never,
        billingAccountId: "account-1",
        degraded: false,
      });
      mockCountActiveSeats.mockResolvedValue(activeSeats);
    }

    it("enforced + at the seat limit — 409 with the exact copy, createInvite not called", async () => {
      mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
      enforcedAtSeats(5, 5);

      const req = makeRequest(
        `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
        "POST",
        { email: "invited@example.com" }
      );
      const res = await POST(req, PARAMS_WS);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(
        "You've reached your team's seat limit. Upgrade your plan or remove an inactive member."
      );
      expect(mockCreateInvite).not.toHaveBeenCalled();
    });

    it("enforced + below the seat limit — 201 unchanged", async () => {
      mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
      mockCreateInvite.mockResolvedValue(MOCK_INVITE);
      enforcedAtSeats(5, 4);

      const req = makeRequest(
        `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
        "POST",
        { email: "invited@example.com" }
      );
      const res = await POST(req, PARAMS_WS);

      expect(res.status).toBe(201);
      const body = (await res.json()) as { invite: { id: string } };
      expect(body.invite.id).toBe("invite-1");
      expect(mockCreateInvite).toHaveBeenCalledWith(
        expect.objectContaining({ email: "invited@example.com" })
      );
    });

    it("flag off (the default) — resolvePolicyForWorkspace is never called, 201 unchanged", async () => {
      mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
      mockCreateInvite.mockResolvedValue(MOCK_INVITE);
      mockSubscriptionsEnforced.mockReturnValue(false);

      const req = makeRequest(
        `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
        "POST",
        { email: "invited@example.com" }
      );
      const res = await POST(req, PARAMS_WS);

      expect(res.status).toBe(201);
      expect(mockResolvePolicy).not.toHaveBeenCalled();
      expect(mockCountActiveSeats).not.toHaveBeenCalled();
    });

    it("degraded resolution — skips the gate entirely, 201", async () => {
      mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
      mockCreateInvite.mockResolvedValue(MOCK_INVITE);
      mockSubscriptionsEnforced.mockReturnValue(true);
      mockResolvePolicy.mockResolvedValue({
        policy: { seatLimit: 1 } as never,
        billingAccountId: "account-1",
        degraded: true,
      });

      const req = makeRequest(
        `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
        "POST",
        { email: "invited@example.com" }
      );
      const res = await POST(req, PARAMS_WS);

      expect(res.status).toBe(201);
      expect(mockCountActiveSeats).not.toHaveBeenCalled();
    });

    it("resolvePolicyForWorkspace throws — fails open, 201", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
      mockCreateInvite.mockResolvedValue(MOCK_INVITE);
      mockSubscriptionsEnforced.mockReturnValue(true);
      mockResolvePolicy.mockRejectedValue(new Error("db blip"));

      const req = makeRequest(
        `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
        "POST",
        { email: "invited@example.com" }
      );
      const res = await POST(req, PARAMS_WS);

      expect(res.status).toBe(201);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[invites] seat gate failed open:",
        expect.any(Error)
      );
      consoleErrorSpy.mockRestore();
    });

    it("uses the zero-spend fetchMonthSpendUsd stub — this gate never reads policy.economics, matching the chat seat gate and the runner capacity gate", async () => {
      mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
      mockCreateInvite.mockResolvedValue(MOCK_INVITE);
      enforcedAtSeats(5, 2);

      const req = makeRequest(
        `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
        "POST",
        { email: "invited@example.com" }
      );
      await POST(req, PARAMS_WS);

      expect(mockResolvePolicy).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({ fetchMonthSpendUsd: expect.any(Function) })
      );
      const deps = mockResolvePolicy.mock.calls[0]?.[1] as {
        fetchMonthSpendUsd: () => Promise<number>;
      };
      await expect(deps.fetchMonthSpendUsd()).resolves.toBe(0);
    });
  });
});

// ---- GET /invites ----

describe("GET /api/v1/workspaces/[workspaceId]/invites", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "GET"
    );
    const res = await GET(req, PARAMS_WS);
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "GET"
    );
    const res = await GET(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns pending invites for a member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(MEMBER_MEMBERSHIP);
    mockListInvites.mockResolvedValue([MOCK_INVITE]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`,
      "GET"
    );
    const res = await GET(req, PARAMS_WS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: Array<{ id: string }> };
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].id).toBe("invite-1");
  });
});

// ---- DELETE /invites/[inviteId] ----

describe("DELETE /api/v1/workspaces/[workspaceId]/invites/[inviteId]", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites/invite-1`,
      "DELETE"
    );
    const res = await DELETE(req, PARAMS_INVITE);
    expect(res.status).toBe(401);
  });

  it("returns 404 when invite not found", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
    mockRevokeInvite.mockResolvedValue(null);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites/invite-1`,
      "DELETE"
    );
    const res = await DELETE(req, PARAMS_INVITE);
    expect(res.status).toBe(404);
  });

  it("sets status to revoked and returns the invite", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
    mockRevokeInvite.mockResolvedValue({ ...MOCK_INVITE, status: "revoked" });

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites/invite-1`,
      "DELETE"
    );
    const res = await DELETE(req, PARAMS_INVITE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invite: { status: string } };
    expect(body.invite.status).toBe("revoked");
    expect(mockRevokeInvite).toHaveBeenCalledWith(WORKSPACE_ID, "invite-1");
  });
});

// ---- GET /members ----

describe("GET /api/v1/workspaces/[workspaceId]/members", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members`,
      "GET"
    );
    const res = await getMembers(req, PARAMS_WS);
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members`,
      "GET"
    );
    const res = await getMembers(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns members and caller_role", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
    mockListWorkspaceMembers.mockResolvedValue([
      {
        userId: "user-123",
        name: "Test User",
        email: "owner@example.com",
        role: "owner",
        joinedAt: new Date("2026-01-01"),
      },
    ]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members`,
      "GET"
    );
    const res = await getMembers(req, PARAMS_WS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      caller_role: string;
      members: Array<{ user_id: string; role: string }>;
    };
    expect(body.caller_role).toBe("owner");
    expect(body.members).toHaveLength(1);
    expect(body.members[0].user_id).toBe("user-123");
    expect(body.members[0].role).toBe("owner");
  });
});

// ---- DELETE /members/[userId] (slice 4 Task 3: removal releases the seat
// only when the removed user holds no remaining membership across ANY
// workspace of the same billing account — spec §5.5 reconciled with §5.2;
// see the route's own doc-comment) ----

describe("DELETE /api/v1/workspaces/[workspaceId]/members/[userId]", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);
    expect(res.status).toBe(401);
    expect(mockRemoveWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("returns 403 when not a workspace member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);
    expect(res.status).toBe(403);
  });

  it("returns 403 when caller is a member (not owner/admin)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(MEMBER_MEMBERSHIP);
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);
    expect(res.status).toBe(403);
    expect(mockRemoveWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("returns 404 when the target user isn't a member (target's own getWorkspaceMembership lookup, BEFORE any delete is attempted)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP) // caller
      .mockResolvedValueOnce(null); // target: not a member
    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);
    expect(res.status).toBe(404);
    expect(mockRemoveWorkspaceMembership).not.toHaveBeenCalled();
    expect(mockGetBillingAccountIdForWorkspace).not.toHaveBeenCalled();
  });

  // ---- Last-owner protection (review fix-round) ----

  it("admin removes the last owner: 409, no delete, no release attempted", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP) // caller (user-123, owner/admin)
      .mockResolvedValueOnce(TARGET_OWNER_MEMBERSHIP); // target (user-456, owner)
    // Only ONE owner in the workspace — the target being removed.
    mockListWorkspaceMembers.mockResolvedValue([
      { userId: "user-456", name: "Sole Owner", email: "owner456@example.com", role: "owner", joinedAt: new Date() },
      { userId: "user-789", name: "Admin", email: "admin@example.com", role: "admin", joinedAt: new Date() },
    ]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Transfer ownership before removing the last owner.");
    expect(mockRemoveWorkspaceMembership).not.toHaveBeenCalled();
    expect(mockReleaseUserSeatForAccount).not.toHaveBeenCalled();
  });

  it("last owner removes themselves: 409 (self-removal is just one case of the last-owner rule, not a separate identity check)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    // Caller AND target are the same row (user-123, the sole owner).
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(OWNER_MEMBERSHIP);
    mockListWorkspaceMembers.mockResolvedValue([
      { userId: "user-123", name: "Sole Owner", email: "owner@example.com", role: "owner", joinedAt: new Date() },
    ]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-123`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_SELF);

    expect(res.status).toBe(409);
    expect(mockRemoveWorkspaceMembership).not.toHaveBeenCalled();
    expect(mockReleaseUserSeatForAccount).not.toHaveBeenCalled();
  });

  it("removing an owner when a SECOND owner exists: 200, normal delete + release-rule path runs", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP) // caller (user-123, owner)
      .mockResolvedValueOnce(TARGET_OWNER_MEMBERSHIP); // target (user-456, owner)
    // TWO owners — the caller (user-123) AND the target (user-456).
    mockListWorkspaceMembers.mockResolvedValue([
      { userId: "user-123", name: "Caller Owner", email: "owner@example.com", role: "owner", joinedAt: new Date() },
      { userId: "user-456", name: "Second Owner", email: "owner456@example.com", role: "owner", joinedAt: new Date() },
    ]);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "owner",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockListAccountWorkspaceIds.mockResolvedValue(["ws-1"]);
    mockListWorkspacesForUser.mockResolvedValue([]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(mockRemoveWorkspaceMembership).toHaveBeenCalledWith(WORKSPACE_ID, "user-456");
    expect(mockReleaseUserSeatForAccount).toHaveBeenCalledWith(expect.anything(), {
      billingAccountId: "account-1",
      userId: "user-456",
    });
  });

  // ---- Seat-release rule (last-workspace-only) — target is a plain member
  // throughout (TARGET_MEMBER_MEMBERSHIP), so the last-owner check above
  // never engages; these exercise the release computation only. ----

  it("last workspace on the account: removes the member AND releases the seat", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(TARGET_MEMBER_MEMBERSHIP);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockListAccountWorkspaceIds.mockResolvedValue(["ws-1", "ws-2"]);
    // No memberships left anywhere for this user post-removal.
    mockListWorkspacesForUser.mockResolvedValue([]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(mockRemoveWorkspaceMembership).toHaveBeenCalledWith(WORKSPACE_ID, "user-456");
    expect(mockReleaseUserSeatForAccount).toHaveBeenCalledWith(expect.anything(), {
      billingAccountId: "account-1",
      userId: "user-456",
    });
  });

  it("mid-account removal (multi-workspace account): removed from ws-1 but still a member of ws-2 on the SAME account — seat is KEPT", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(TARGET_MEMBER_MEMBERSHIP);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockListAccountWorkspaceIds.mockResolvedValue(["ws-1", "ws-2"]);
    // Still a member of ws-2, which belongs to the SAME account.
    mockListWorkspacesForUser.mockResolvedValue([
      { id: "ws-2", name: "Other WS", slug: "other-ws", createdAt: new Date(), updatedAt: new Date(), role: "member" },
    ]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(mockReleaseUserSeatForAccount).not.toHaveBeenCalled();
  });

  it("remaining memberships all belong to a DIFFERENT billing account: still releases (zero remaining IN THIS account)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(TARGET_MEMBER_MEMBERSHIP);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockListAccountWorkspaceIds.mockResolvedValue(["ws-1", "ws-2"]);
    // Still a member elsewhere, but that workspace is NOT one of account-1's.
    mockListWorkspacesForUser.mockResolvedValue([
      { id: "ws-other-account", name: "Unrelated", slug: "unrelated", createdAt: new Date(), updatedAt: new Date(), role: "member" },
    ]);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(mockReleaseUserSeatForAccount).toHaveBeenCalledWith(expect.anything(), {
      billingAccountId: "account-1",
      userId: "user-456",
    });
  });

  it("null billing account (transitional workspace): skips release silently, removal still succeeds", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(TARGET_MEMBER_MEMBERSHIP);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue(null);

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(mockListAccountWorkspaceIds).not.toHaveBeenCalled();
    expect(mockReleaseUserSeatForAccount).not.toHaveBeenCalled();
  });

  it("releaseUserSeatForAccount throws: caught and logged, removal still returns 200 (non-fatal)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(TARGET_MEMBER_MEMBERSHIP);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockListAccountWorkspaceIds.mockResolvedValue(["ws-1"]);
    mockListWorkspacesForUser.mockResolvedValue([]);
    mockReleaseUserSeatForAccount.mockRejectedValue(new Error("db unavailable"));

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("listWorkspacesForUser throws: caught and logged, removal still returns 200 (non-fatal)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership
      .mockResolvedValueOnce(OWNER_MEMBERSHIP)
      .mockResolvedValueOnce(TARGET_MEMBER_MEMBERSHIP);
    mockRemoveWorkspaceMembership.mockResolvedValue({
      userId: "user-456",
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockListAccountWorkspaceIds.mockResolvedValue(["ws-1"]);
    mockListWorkspacesForUser.mockRejectedValue(new Error("timeout"));

    const req = makeRequest(
      `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members/user-456`,
      "DELETE"
    );
    const res = await removeMember(req, PARAMS_MEMBER);

    expect(res.status).toBe(200);
    expect(mockReleaseUserSeatForAccount).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
