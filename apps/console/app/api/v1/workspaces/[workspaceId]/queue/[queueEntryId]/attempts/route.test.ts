import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listQueueAttempts: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listQueueAttempts } from "@agentrail/db-postgres";

const WORKSPACE_ID = "ws-123";
const QUEUE_ENTRY_ID = "entry-1";

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/queue/${QUEUE_ENTRY_ID}/attempts`
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, queueEntryId: QUEUE_ENTRY_ID }) };
}

function mockMember(role: string = "member") {
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: "user-1",
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

describe("GET /api/v1/workspaces/:workspaceId/queue/:queueEntryId/attempts (#1389 AC3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(listQueueAttempts).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(listQueueAttempts).not.toHaveBeenCalled();
  });

  it("any member role (not just admin/owner) can read attempt history — this is a read, not a mutation", async () => {
    mockMember("viewer");
    vi.mocked(listQueueAttempts).mockResolvedValue([]);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
  });

  it("returns the workspace-scoped attempt list from listQueueAttempts", async () => {
    mockMember("owner");
    const attempts = [
      {
        id: "a1",
        tier: 0,
        outcome: "red",
        errorSummary: "objective gate failed",
        createdAt: "2026-07-26T10:00:00.000Z",
      },
      {
        id: "a2",
        tier: 1,
        outcome: "escalated-to-human",
        errorSummary: null,
        createdAt: "2026-07-26T10:05:00.000Z",
      },
    ];
    vi.mocked(listQueueAttempts).mockResolvedValue(attempts);
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.attempts).toEqual(attempts);
    expect(listQueueAttempts).toHaveBeenCalledWith(WORKSPACE_ID, QUEUE_ENTRY_ID);
  });

  it("returns 500 with a stable error shape when the query throws", async () => {
    mockMember("owner");
    vi.mocked(listQueueAttempts).mockRejectedValue(new Error("db down"));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
