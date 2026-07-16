import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  upsertConnector: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, upsertConnector } from "@agentrail/db-postgres";

const WS = "ws-1";
const USER = "user-1";

function req(body: unknown = {}): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/onboarding/skip-channel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}
function params() {
  return { params: Promise.resolve({ workspaceId: WS }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "owner" } as never);
  vi.mocked(upsertConnector).mockResolvedValue({} as never);
});

describe("POST /api/v1/workspaces/[workspaceId]/onboarding/skip-channel", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(401);
  });

  it("403 when not a member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
  });

  it("403 when a member but not owner/admin", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "member" } as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
  });

  it("records the skip on the telegram connector row (default body)", async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(upsertConnector).toHaveBeenCalledWith(WS, "telegram", {
      config: { channelSkippedAt: expect.any(String) },
    });
  });

  it("admin role can also skip", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1", role: "admin" } as never);
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
  });

  it("clears the skip when skip:false is passed (undo)", async () => {
    const res = await POST(req({ skip: false }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(false);
    expect(upsertConnector).toHaveBeenCalledWith(WS, "telegram", {
      config: { channelSkippedAt: undefined },
    });
  });
});
