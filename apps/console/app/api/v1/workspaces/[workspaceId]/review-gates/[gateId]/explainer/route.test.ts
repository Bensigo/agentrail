import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getReviewGateExplainer: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import {
  getReviewGateExplainer,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";

const WS = "00000000-0000-0000-0000-000000000001";
const GATE = "00000000-0000-0000-0000-000000000021";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/review-gates/${GATE}/explainer`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, gateId: GATE });
}

const explainer = [
  { category: "tests", present: true, finding_count: 1 },
  { category: "visual", present: true, finding_count: 1 },
  { category: "citations", present: false, finding_count: 0 },
  { category: "ac", present: false, finding_count: 0 },
  { category: "blocked", present: false, finding_count: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getReviewGateExplainer).mockResolvedValue({
    gate: { id: GATE },
    explainer,
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/review-gates/[gateId]/explainer", () => {
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

  it("200 with all five category statuses", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ explainer });
    expect(json.explainer).toHaveLength(5);
    expect(getReviewGateExplainer).toHaveBeenCalledWith(WS, GATE);
  });

  it("404 when the gate does not exist in the workspace", async () => {
    vi.mocked(getReviewGateExplainer).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(404);
  });
});
