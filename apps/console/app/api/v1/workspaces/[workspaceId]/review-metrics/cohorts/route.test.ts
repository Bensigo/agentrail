import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getReviewMetrics: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getReviewMetrics, getWorkspaceMembership } from "@agentrail/db-postgres";
import { GET } from "./route";

const WORKSPACE_ID = "ws-1";
const FROM = "2026-08-03T00:00:00Z";
const TO = "2026-08-04T00:00:00Z";

function request(query: Record<string, string | undefined> = {}) {
  const url = new URL("http://localhost/api/v1/workspaces/ws-1/review-metrics/cohorts");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new NextRequest(url, { method: "GET" });
}

function params() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

const metric = {
  workspaceId: WORKSPACE_ID,
  taskFamily: "dependency-upgrade",
  dateRange: { from: new Date(FROM), to: new Date(TO) },
  sampleSize: 0,
  denominator: { openedPullRequests: 0, terminalPullRequests: 0, mergeRate: 0 },
  medianTimeToFirstReviewSeconds: { value: null, knownSampleSize: 0 },
  averageReviewCycles: { value: null, knownSampleSize: 0 },
  medianPrSizeLines: { value: null, knownSampleSize: 0 },
  mergeRate: { value: null, knownSampleSize: 0 },
  postMergeReworkEvents: { value: null, knownSampleSize: 0 },
  humanReviewMinutes: { value: null, knownSampleSize: 0 },
  exclusions: ["no complete pull requests"],
  limitations: ["human review minutes are explicit only"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ workspaceId: WORKSPACE_ID } as never);
  vi.mocked(getReviewMetrics).mockResolvedValue([metric] as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/review-metrics/cohorts", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await GET(request({ from: FROM, to: TO }), params())).status).toBe(401);
  });

  it("returns 403 for a non-member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    expect((await GET(request({ from: FROM, to: TO }), params())).status).toBe(403);
  });

  it.each([
    { from: "not-a-date", to: TO },
    { from: FROM, to: "2026-08-03T00:00:00Z" },
    { from: TO, to: FROM },
    { from: FROM, to: TO, observedUntil: "bad" },
  ])("returns 400 for malformed or non-positive range: %j", async (query) => {
    const res = await GET(request(query), params());
    expect(res.status).toBe(400);
    expect(getReviewMetrics).not.toHaveBeenCalled();
  });

  it("returns populated cohorts and defaults observedUntil to to", async () => {
    const res = await GET(request({ from: FROM, to: TO }), params());
    expect(res.status).toBe(200);
    expect(getReviewMetrics).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      from: new Date(FROM),
      to: new Date(TO),
      observedUntil: new Date(TO),
    });
    expect(await res.json()).toEqual({
      cohorts: [expect.objectContaining({ taskFamily: "dependency-upgrade", sampleSize: 0 })],
    });
  });

  it("preserves unknown metric values and known sample sizes", async () => {
    const res = await GET(request({ from: FROM, to: TO, observedUntil: TO }), params());
    const body = await res.json();
    expect(body.cohorts[0]).toEqual(expect.objectContaining({
      medianTimeToFirstReviewSeconds: { value: null, knownSampleSize: 0 },
      averageReviewCycles: { value: null, knownSampleSize: 0 },
      medianPrSizeLines: { value: null, knownSampleSize: 0 },
      mergeRate: { value: null, knownSampleSize: 0 },
      postMergeReworkEvents: { value: null, knownSampleSize: 0 },
      humanReviewMinutes: { value: null, knownSampleSize: 0 },
      denominator: { openedPullRequests: 0, terminalPullRequests: 0, mergeRate: 0 },
      exclusions: ["no complete pull requests"],
      limitations: ["human review minutes are explicit only"],
    }));
  });
});
