import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getReviewMetricsReport: vi.fn(),
  getWorkspaceMembership: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getReviewMetricsReport, getWorkspaceMembership } from "@agentrail/db-postgres";
import { GET } from "./route";

const WORKSPACE_ID = "ws-1";
const NOW = new Date("2026-08-03T00:00:00Z");

function request(query: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/v1/workspaces/ws-1/review-metrics");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ workspaceId: WORKSPACE_ID } as never);
  vi.mocked(getReviewMetricsReport).mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    taskFamily: "dependency-upgrade",
    current: {
      workspaceId: WORKSPACE_ID,
      taskFamily: "dependency-upgrade",
      dateRange: { from: NOW, to: new Date("2026-08-04T00:00:00Z") },
      sampleSize: 1,
      denominator: { openedPullRequests: 1, terminalPullRequests: 1, mergeRate: 1 },
      medianTimeToFirstReviewSeconds: { value: 1200, knownSampleSize: 1 },
      averageReviewCycles: { value: 1, knownSampleSize: 1 },
      medianPrSizeLines: { value: 40, knownSampleSize: 1 },
      mergeRate: { value: 1, knownSampleSize: 1 },
      postMergeReworkEvents: { value: 0, knownSampleSize: 1 },
      humanReviewMinutes: { value: 18, knownSampleSize: 1 },
      exclusions: [],
      limitations: ["human review minutes are explicit only"],
    },
    baseline: {
      workspaceId: WORKSPACE_ID,
      taskFamily: "dependency-upgrade",
      dateRange: { from: new Date("2026-07-27T00:00:00Z"), to: new Date("2026-07-28T00:00:00Z") },
      sampleSize: 1,
      denominator: { openedPullRequests: 1, terminalPullRequests: 1, mergeRate: 1 },
      medianTimeToFirstReviewSeconds: { value: 1800, knownSampleSize: 1 },
      averageReviewCycles: { value: 1, knownSampleSize: 1 },
      medianPrSizeLines: { value: 42, knownSampleSize: 1 },
      mergeRate: { value: 1, knownSampleSize: 1 },
      postMergeReworkEvents: { value: 0, knownSampleSize: 1 },
      humanReviewMinutes: { value: 12, knownSampleSize: 1 },
      exclusions: [],
      limitations: ["human review minutes are explicit only"],
    },
    comparison: {
      sampleSizeDelta: 0,
      denominatorDelta: { openedPullRequests: 0, terminalPullRequests: 0, mergeRate: 0 },
      medianTimeToFirstReviewSecondsDelta: -600,
      averageReviewCyclesDelta: 0,
      medianPrSizeLinesDelta: -2,
      mergeRateDelta: 0,
      postMergeReworkEventsDelta: 0,
      humanReviewMinutesDelta: 6,
    },
  } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/review-metrics", () => {
  it("401 without a session", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(request({
      from: "2026-08-03T00:00:00Z",
      to: "2026-08-04T00:00:00Z",
      taskFamily: "dependency-upgrade",
    }), { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    expect(res.status).toBe(401);
  });

  it("403 for a non-member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(request({
      from: "2026-08-03T00:00:00Z",
      to: "2026-08-04T00:00:00Z",
      taskFamily: "dependency-upgrade",
    }), { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    expect(res.status).toBe(403);
  });

  it("400 when required query params are missing", async () => {
    const res = await GET(request(), { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    expect(res.status).toBe(400);
  });

  it("returns a dated task-family report with optional baseline comparison", async () => {
    const res = await GET(request({
      from: "2026-08-03T00:00:00Z",
      to: "2026-08-04T00:00:00Z",
      taskFamily: "dependency-upgrade",
      baselineFrom: "2026-07-27T00:00:00Z",
      baselineTo: "2026-07-28T00:00:00Z",
    }), { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });

    expect(res.status).toBe(200);
    expect(getReviewMetricsReport).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      taskFamily: "dependency-upgrade",
      from: new Date("2026-08-03T00:00:00Z"),
      to: new Date("2026-08-04T00:00:00Z"),
      baselineFrom: new Date("2026-07-27T00:00:00Z"),
      baselineTo: new Date("2026-07-28T00:00:00Z"),
    }));
    expect(await res.json()).toEqual({
      report: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        taskFamily: "dependency-upgrade",
        current: expect.objectContaining({
          dateRange: {
            from: "2026-08-03T00:00:00.000Z",
            to: "2026-08-04T00:00:00.000Z",
          },
          sampleSize: 1,
          humanReviewMinutes: { value: 18, knownSampleSize: 1 },
        }),
        baseline: expect.objectContaining({
          dateRange: {
            from: "2026-07-27T00:00:00.000Z",
            to: "2026-07-28T00:00:00.000Z",
          },
          sampleSize: 1,
          humanReviewMinutes: { value: 12, knownSampleSize: 1 },
        }),
        comparison: {
          sampleSizeDelta: 0,
          denominatorDelta: { openedPullRequests: 0, terminalPullRequests: 0, mergeRate: 0 },
          medianTimeToFirstReviewSecondsDelta: -600,
          averageReviewCyclesDelta: 0,
          medianPrSizeLinesDelta: -2,
          mergeRateDelta: 0,
          postMergeReworkEventsDelta: 0,
          humanReviewMinutesDelta: 6,
        },
      }),
    });
  });
});
