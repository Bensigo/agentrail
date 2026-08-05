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

const unknownMetric = {
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

const populatedMetric = {
  workspaceId: WORKSPACE_ID,
  taskFamily: "dependency-upgrade",
  dateRange: { from: new Date(FROM), to: new Date(TO) },
  sampleSize: 4,
  denominator: { openedPullRequests: 4, terminalPullRequests: 3, mergeRate: 3 },
  medianTimeToFirstReviewSeconds: { value: 1200, knownSampleSize: 3 },
  averageReviewCycles: { value: 1.5, knownSampleSize: 3 },
  medianPrSizeLines: { value: 42, knownSampleSize: 3 },
  mergeRate: { value: 0.75, knownSampleSize: 3 },
  postMergeReworkEvents: { value: 1, knownSampleSize: 3 },
  humanReviewMinutes: { value: 18, knownSampleSize: 3 },
  exclusions: ["1 conflicting delivery replay(s)"],
  limitations: ["human review minutes are explicit only"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ workspaceId: WORKSPACE_ID } as never);
  vi.mocked(getReviewMetrics).mockResolvedValue([unknownMetric] as never);
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

  it("returns cohorts and defaults observedUntil to to", async () => {
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

  it("serializes populated metric values, dates, denominators, and evidence metadata", async () => {
    vi.mocked(getReviewMetrics).mockResolvedValue([populatedMetric] as never);

    const res = await GET(request({ from: FROM, to: TO }), params());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cohorts: [{
        ...populatedMetric,
        dateRange: {
          from: new Date(FROM).toISOString(),
          to: new Date(TO).toISOString(),
        },
      }],
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
