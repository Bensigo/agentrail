import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";

const { mockAuth, mockGetMembership } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetMembership: vi.fn(),
}));

vi.mock("@agentrail/auth", () => ({ auth: mockAuth }));
vi.mock("@agentrail/db-postgres", () => ({ getWorkspaceMembership: mockGetMembership }));

import { POST } from "./route";

function request(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/change-records/${RECORD_ID}/gated-issue`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: USER_ID } });
  mockGetMembership.mockResolvedValue({ role: "owner" });
});

describe("POST Acceptance gated issue", () => {
  it("refuses browser publication without loading a credential or writer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(request(), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      kind: "jace_approval_required",
      recordId: RECORD_ID,
      message: "Ask Jace to create the current correction issue for this Acceptance Record.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves browser authentication and owner/admin membership", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await POST(request(), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID }),
    })).status).toBe(401);

    mockGetMembership.mockResolvedValueOnce({ role: "member" });
    expect((await POST(request(), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, recordId: RECORD_ID }),
    })).status).toBe(403);
  });
});
