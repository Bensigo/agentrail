import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  createInvite: vi.fn(),
  listInvites: vi.fn(),
  revokeInvite: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}));

import { GET, POST } from "../route";
import { DELETE } from "../../invites/[inviteId]/route";
import { GET as getMembers } from "../../members/route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  createInvite,
  listInvites,
  revokeInvite,
  listWorkspaceMembers,
} from "@agentrail/db-postgres";

const mockAuth = vi.mocked(auth);
const mockGetWorkspaceMembership = vi.mocked(getWorkspaceMembership);
const mockCreateInvite = vi.mocked(createInvite);
const mockListInvites = vi.mocked(listInvites);
const mockRevokeInvite = vi.mocked(revokeInvite);
const mockListWorkspaceMembers = vi.mocked(listWorkspaceMembers);

const VALID_SESSION = {
  user: { id: "user-123", name: "Test User", email: "owner@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const OWNER_MEMBERSHIP = { userId: "user-123", workspaceId: "ws-1", role: "owner" as const, createdAt: new Date() };
const MEMBER_MEMBERSHIP = { userId: "user-123", workspaceId: "ws-1", role: "member" as const, createdAt: new Date() };

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

function makeRequest(
  url: string,
  method: string,
  body?: unknown
): NextRequest {
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

// ---- POST /invites ----

describe("POST /api/v1/workspaces/[workspaceId]/invites", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "x@y.com",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a workspace member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "x@y.com",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns 403 when caller is a member (not owner/admin)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(MEMBER_MEMBERSHIP);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "x@y.com",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns 400 when email is missing", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when email is invalid", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "not-an-email",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(400);
  });

  it("returns 400 when role is owner", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "x@y.com",
      role: "owner",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(400);
  });

  it("returns 201 with invite including token on success (upsert)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(OWNER_MEMBERSHIP);
    mockCreateInvite.mockResolvedValue(MOCK_INVITE);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "POST", {
      email: "invited@example.com",
    });
    const res = await POST(req, PARAMS_WS);
    expect(res.status).toBe(201);
    const body = await res.json() as { invite: { id: string; token: string } };
    expect(body.invite.id).toBe("invite-1");
    expect(body.invite.token).toBe("tok123");
    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.objectContaining({ email: "invited@example.com" })
    );
  });
});

// ---- GET /invites ----

describe("GET /api/v1/workspaces/[workspaceId]/invites", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "GET");
    const res = await GET(req, PARAMS_WS);
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "GET");
    const res = await GET(req, PARAMS_WS);
    expect(res.status).toBe(403);
  });

  it("returns pending invites for a member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(MEMBER_MEMBERSHIP);
    mockListInvites.mockResolvedValue([MOCK_INVITE]);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/invites`, "GET");
    const res = await GET(req, PARAMS_WS);
    expect(res.status).toBe(200);
    const body = await res.json() as { invites: Array<{ id: string }> };
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
    const body = await res.json() as { invite: { status: string } };
    expect(body.invite.status).toBe("revoked");
    expect(mockRevokeInvite).toHaveBeenCalledWith(WORKSPACE_ID, "invite-1");
  });
});

// ---- GET /members ----

describe("GET /api/v1/workspaces/[workspaceId]/members", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members`, "GET");
    const res = await getMembers(req, PARAMS_WS);
    expect(res.status).toBe(401);
  });

  it("returns 403 when not a member", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockGetWorkspaceMembership.mockResolvedValue(null);

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members`, "GET");
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

    const req = makeRequest(`http://localhost/api/v1/workspaces/${WORKSPACE_ID}/members`, "GET");
    const res = await getMembers(req, PARAMS_WS);
    expect(res.status).toBe(200);
    const body = await res.json() as { caller_role: string; members: Array<{ user_id: string; role: string }> };
    expect(body.caller_role).toBe("owner");
    expect(body.members).toHaveLength(1);
    expect(body.members[0].user_id).toBe("user-123");
    expect(body.members[0].role).toBe("owner");
  });
});
