import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  requeueDeadChannelMessage: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, requeueDeadChannelMessage } from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const MESSAGE_ID = "msg-1";

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/channel-inbox/${MESSAGE_ID}/requeue`,
    { method: "POST" }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, id: MESSAGE_ID }) };
}

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: "user-1",
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/channel-inbox/:id/requeue", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 for a member role", async () => {
    mockMember("member");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(requeueDeadChannelMessage).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner: requeues the dead letter", async () => {
    mockMember("owner");
    vi.mocked(requeueDeadChannelMessage).mockResolvedValue(true);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(requeueDeadChannelMessage).toHaveBeenCalledWith(WORKSPACE_ID, MESSAGE_ID);
  });

  it("admin: also allowed", async () => {
    mockMember("admin");
    vi.mocked(requeueDeadChannelMessage).mockResolvedValue(true);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });

  it("returns 404 when the row is not found, belongs to another workspace, or is no longer dead", async () => {
    mockMember("owner");
    vi.mocked(requeueDeadChannelMessage).mockResolvedValue(false);
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });
});
