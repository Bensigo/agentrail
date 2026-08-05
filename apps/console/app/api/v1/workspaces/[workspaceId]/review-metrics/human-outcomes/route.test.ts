import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  recordReviewEvent: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, recordReviewEvent } from "@agentrail/db-postgres";
import { POST } from "./route";

const mockAuth = vi.mocked(auth);
const mockMembership = vi.mocked(getWorkspaceMembership);
const mockRecord = vi.mocked(recordReviewEvent);
const workspaceId = "5d3d92b8-b348-4da0-8cb6-039795ce04c2";
const sha = "a".repeat(40);

function request(body: unknown) {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${workspaceId}/review-metrics/human-outcomes`,
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }
  );
}

const valid = {
  repo: "Bensigo/agentrail",
  prNumber: 1630,
  headSha: sha,
  outcome: "post_merge_rework",
  occurredAt: "2026-08-05T12:00:00.000Z",
  idempotencyKey: "operator-action-0001",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
  mockMembership.mockResolvedValue({ role: "member" } as never);
  mockRecord.mockResolvedValue({ recorded: true, eventId: "event-1" });
});

describe("POST human review outcome", () => {
  it("records only explicit human post-merge rework with exact PR identity", async () => {
    const response = await POST(request(valid), { params: Promise.resolve({ workspaceId }) });

    expect(response.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith({
      workspaceId,
      repo: "Bensigo/agentrail",
      prNumber: 1630,
      deliveryId: `human-outcome:${workspaceId}:user-1:operator-action-0001`,
      eventType: "post_merge_rework",
      occurredAt: new Date("2026-08-05T12:00:00.000Z"),
      headSha: sha,
      actorType: "human",
    });
  });

  it("returns duplicate information without recording a second numerator event", async () => {
    mockRecord.mockResolvedValue({ recorded: false, eventId: null });

    const response = await POST(request({ ...valid, outcome: "reverted" }), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false, eventId: null, duplicate: true });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated and non-member callers", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(request(valid), { params: Promise.resolve({ workspaceId }) })).status).toBe(401);

    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockMembership.mockResolvedValue(null as never);
    expect((await POST(request(valid), { params: Promise.resolve({ workspaceId }) })).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("rejects inferred evidence inputs before the database is called", async () => {
    const response = await POST(
      request({ ...valid, outcome: "head_updated", headSha: "not-an-exact-head" }),
      { params: Promise.resolve({ workspaceId }) }
    );

    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
