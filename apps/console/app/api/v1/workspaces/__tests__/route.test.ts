import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  listWorkspacesForUser: vi.fn(),
  createWorkspace: vi.fn(),
}));

import { POST } from "../route";
import { auth } from "@agentrail/auth";
import { createWorkspace } from "@agentrail/db-postgres";

const mockAuth = vi.mocked(auth);
const mockCreateWorkspace = vi.mocked(createWorkspace);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_SESSION = {
  user: { id: "user-123", name: "Test User", email: "test@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const VALID_WORKSPACE = {
  id: "ws-abc",
  name: "My Workspace",
  slug: "my-workspace",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/workspaces", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await POST(makeRequest({ name: "My Workspace", slug: "my-workspace" }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: unknown };
    expect(body.error).toBeTruthy();
  });

  it("creates workspace and returns 201 on success", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    mockCreateWorkspace.mockResolvedValue(VALID_WORKSPACE);

    const res = await POST(makeRequest({ name: "My Workspace", slug: "my-workspace" }));

    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; name: string; slug: string };
    expect(body.id).toBe("ws-abc");
    expect(body.name).toBe("My Workspace");
    expect(body.slug).toBe("my-workspace");
    expect(mockCreateWorkspace).toHaveBeenCalledWith({
      name: "My Workspace",
      slug: "my-workspace",
      userId: "user-123",
    });
  });

  it("returns 409 on slug conflict (postgres 23505 error)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    const conflictErr = Object.assign(new Error("unique violation"), { code: "23505" });
    mockCreateWorkspace.mockRejectedValue(conflictErr);

    const res = await POST(makeRequest({ name: "My Workspace", slug: "my-workspace" }));

    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; field: string } };
    expect(body.error.code).toBe("SLUG_CONFLICT");
    expect(body.error.field).toBe("slug");
  });

  it("returns 400 when slug is missing", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);

    const res = await POST(makeRequest({ name: "My Workspace", slug: "" }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { field: string } };
    expect(body.error.field).toBe("slug");
  });

  it("returns 400 when slug contains invalid characters", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);

    const res = await POST(makeRequest({ name: "My Workspace", slug: "My Workspace!" }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; field: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.field).toBe("slug");
  });

  it("returns 400 when name is empty", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);

    const res = await POST(makeRequest({ name: "", slug: "my-workspace" }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { field: string } };
    expect(body.error.field).toBe("name");
  });

  it("returns 400 when name exceeds 80 characters", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as Awaited<ReturnType<typeof auth>>);
    const longName = "a".repeat(81);

    const res = await POST(makeRequest({ name: longName, slug: "my-workspace" }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { field: string } };
    expect(body.error.field).toBe("name");
  });
});
