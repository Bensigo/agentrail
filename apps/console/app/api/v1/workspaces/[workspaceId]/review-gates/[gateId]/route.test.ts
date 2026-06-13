import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getReviewGate: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getReviewGate, getWorkspaceMembership } from "@agentrail/db-postgres";

const WS = "00000000-0000-0000-0000-000000000001";
const GATE = "00000000-0000-0000-0000-000000000021";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/review-gates/${GATE}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, gateId: GATE });
}

const sampleGate = {
  id: GATE,
  workspaceId: WS,
  runId: "00000000-0000-0000-0000-000000000010",
  gateName: "Verification evidence",
  status: "failed",
  conditions: [],
  blockingReasons: [],
  evidenceRefs: [],
  findings: [],
  evaluatedAt: new Date("2026-06-08T08:04:00.000Z"),
  createdAt: new Date("2026-06-08T08:04:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getReviewGate).mockResolvedValue(sampleGate as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/review-gates/[gateId]", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when user is not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("200 with the full gate record", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gate.id).toBe(GATE);
    expect(json.gate.gateName).toBe("Verification evidence");
    expect(getReviewGate).toHaveBeenCalledWith(WS, GATE);
  });

  it("404 when the gate does not exist in the workspace", async () => {
    vi.mocked(getReviewGate).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(404);
  });
});
