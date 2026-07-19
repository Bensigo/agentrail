import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  requeueParkedQueueEntry: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, requeueParkedQueueEntry } from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const QUEUE_ENTRY_ID = "entry-1";

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/queue/${QUEUE_ENTRY_ID}/requeue`,
    { method: "POST" }
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, queueEntryId: QUEUE_ENTRY_ID }) };
}

function mockMember(role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: "user-1",
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("POST /api/v1/workspaces/:workspaceId/queue/:queueEntryId/requeue", () => {
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
    expect(requeueParkedQueueEntry).not.toHaveBeenCalled();
  });

  it("returns 403 for a member role", async () => {
    mockMember("member");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(requeueParkedQueueEntry).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer role", async () => {
    mockMember("viewer");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("owner: a guardrail/dependency park requeues", async () => {
    mockMember("owner");
    vi.mocked(requeueParkedQueueEntry).mockResolvedValue("requeued");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    expect(requeueParkedQueueEntry).toHaveBeenCalledWith(WORKSPACE_ID, QUEUE_ENTRY_ID);
  });

  it("admin: also allowed", async () => {
    mockMember("admin");
    vi.mocked(requeueParkedQueueEntry).mockResolvedValue("requeued");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });

  it("returns 404 when the entry does not exist (or belongs to another workspace)", async () => {
    mockMember("owner");
    vi.mocked(requeueParkedQueueEntry).mockResolvedValue("not_found");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 409 when the entry is no longer parked", async () => {
    mockMember("owner");
    vi.mocked(requeueParkedQueueEntry).mockResolvedValue("not_parked");
    const res = await POST(makeRequest(), makeParams());
    expect(res.status).toBe(409);
  });

  it("alignment-park requeue rejected: returns 409 and never bypasses the alignment gate", async () => {
    mockMember("owner");
    vi.mocked(requeueParkedQueueEntry).mockResolvedValue("alignment_locked");

    const res = await POST(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toMatch(/alignment/i);
  });
});
