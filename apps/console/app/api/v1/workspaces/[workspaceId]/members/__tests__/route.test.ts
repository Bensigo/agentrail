import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── mock @agentrail/auth ────────────────────────────────────────────────────
vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

// ── mock @agentrail/db-postgres ─────────────────────────────────────────────
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  findUserByEmail: vi.fn(),
  addWorkspaceMember: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  findUserByEmail,
  addWorkspaceMember,
} from "@agentrail/db-postgres";
import { GET, POST } from "../route";

// Helpers
const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";
const OWNER_ID     = "u-owner-0000-0000-0000-000000000001";
const ADMIN_ID     = "u-admin-0000-0000-0000-000000000001";
const MEMBER_ID    = "u-member-000-0000-0000-000000000001";
const TARGET_ID    = "u-target-000-0000-0000-000000000001";
const TARGET_EMAIL = "new@example.com";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/workspaces/" + WORKSPACE_ID + "/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockRouteParams(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function makeMembership(userId: string, role: string) {
  return {
    userId,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date("2024-01-01T00:00:00Z"),
  };
}

function makeUser(id: string, email: string) {
  return { id, email, name: "Test User", image: null, emailVerified: null };
}

function makeNewMembership(userId: string, role: string) {
  return {
    userId,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date("2024-06-01T00:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── POST tests ───────────────────────────────────────────────────────────────

describe("POST /api/v1/workspaces/:workspaceId/members", () => {
  it("401 — unauthenticated caller", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue(null as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "member" }), mockRouteParams());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("403 — caller has no membership in this workspace", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: "outsider" } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "member" }), mockRouteParams());
    expect(res.status).toBe(403);
  });

  it("403 — caller is member-role (not owner or admin)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: MEMBER_ID } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getWorkspaceMembership).mockResolvedValue(makeMembership(MEMBER_ID, "member") as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "member" }), mockRouteParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/owner or admin/i);
  });

  it("403 — admin caller trying to grant admin role", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: ADMIN_ID } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getWorkspaceMembership).mockResolvedValue(makeMembership(ADMIN_ID, "admin") as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "admin" }), mockRouteParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/owners can grant/i);
  });

  it("404 — no user with that email", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: OWNER_ID } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getWorkspaceMembership).mockResolvedValue(makeMembership(OWNER_ID, "owner") as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(findUserByEmail).mockResolvedValue(null as any);

    const res = await POST(makeRequest({ email: "ghost@example.com", role: "member" }), mockRouteParams());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("no_user");
    expect(body.message).toContain("sign in");
  });

  it("409 — user already a member", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: OWNER_ID } } as any);
    vi.mocked(getWorkspaceMembership)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(makeMembership(OWNER_ID, "owner") as any)  // caller membership
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(makeMembership(TARGET_ID, "member") as any); // target already member
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(findUserByEmail).mockResolvedValue(makeUser(TARGET_ID, TARGET_EMAIL) as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "member" }), mockRouteParams());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_member");
  });

  it("201 — owner adds a member-role user successfully", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: OWNER_ID } } as any);
    vi.mocked(getWorkspaceMembership)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(makeMembership(OWNER_ID, "owner") as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(null as any); // target not yet a member
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(findUserByEmail).mockResolvedValue(makeUser(TARGET_ID, TARGET_EMAIL) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(addWorkspaceMember).mockResolvedValue(makeNewMembership(TARGET_ID, "member") as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "member" }), mockRouteParams());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member.role).toBe("member");
    expect(body.member.user_id).toBe(TARGET_ID);
  });

  it("201 — owner adds an admin-role user successfully", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: OWNER_ID } } as any);
    vi.mocked(getWorkspaceMembership)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(makeMembership(OWNER_ID, "owner") as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(null as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(findUserByEmail).mockResolvedValue(makeUser(TARGET_ID, TARGET_EMAIL) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(addWorkspaceMember).mockResolvedValue(makeNewMembership(TARGET_ID, "admin") as any);

    const res = await POST(makeRequest({ email: TARGET_EMAIL, role: "admin" }), mockRouteParams());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member.role).toBe("admin");
  });
});

// ── GET tests ────────────────────────────────────────────────────────────────

describe("GET /api/v1/workspaces/:workspaceId/members", () => {
  it("401 — unauthenticated", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue(null as any);

    const req = new NextRequest("http://localhost/api/v1/workspaces/" + WORKSPACE_ID + "/members");
    const res = await GET(req, mockRouteParams());
    expect(res.status).toBe(401);
  });

  it("403 — caller has no membership", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(auth).mockResolvedValue({ user: { id: "outsider" } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as any);

    const req = new NextRequest("http://localhost/api/v1/workspaces/" + WORKSPACE_ID + "/members");
    const res = await GET(req, mockRouteParams());
    expect(res.status).toBe(403);
  });
});
