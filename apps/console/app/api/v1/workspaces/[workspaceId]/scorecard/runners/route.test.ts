import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getRunnerRunStats: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getRunnerCostStats: vi.fn(),
  getRunnerContextEfficiency: vi.fn(),
}));
vi.mock("../../../../../../../lib/runner-scorecard", () => ({
  buildRunnerScorecard: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRunnerRunStats } from "@agentrail/db-postgres";
import { getRunnerCostStats, getRunnerContextEfficiency } from "@agentrail/db-clickhouse";
import { buildRunnerScorecard } from "../../../../../../../lib/runner-scorecard";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = "") {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/scorecard/runners${search}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleRunStats = [
  {
    runner_name: "claude",
    run_ids: ["run-1", "run-2"],
    total_count: 2,
    success_count: 2,
    human_review_count: 0,
    review_fix_count: 1,
  },
  {
    runner_name: "codex",
    run_ids: ["run-3"],
    total_count: 1,
    success_count: 0,
    human_review_count: null,
    review_fix_count: null,
  },
];

const sampleRunnerRows = [
  {
    runner_name: "claude",
    success_rate: 1.0,
    review_fix_rate: 0.5,
    human_review_rate: 0.0,
    cost_per_merged_pr: 0.6,
    context_efficiency: 0.75,
    run_ids: ["run-1", "run-2"],
  },
  {
    runner_name: "codex",
    success_rate: null,
    review_fix_rate: null,
    human_review_rate: null,
    cost_per_merged_pr: null,
    context_efficiency: null,
    run_ids: ["run-3"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRunnerRunStats).mockResolvedValue(sampleRunStats as never);
  vi.mocked(getRunnerCostStats).mockResolvedValue([]);
  vi.mocked(getRunnerContextEfficiency).mockResolvedValue([]);
  vi.mocked(buildRunnerScorecard).mockReturnValue(sampleRunnerRows as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/scorecard/runners", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("403 when user not a member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("AC1: 200 with runners array containing all 5 metric fields", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.runners)).toBe(true);
    const row = json.runners[0];
    expect(row).toHaveProperty("runner_name");
    expect(row).toHaveProperty("success_rate");
    expect(row).toHaveProperty("review_fix_rate");
    expect(row).toHaveProperty("human_review_rate");
    expect(row).toHaveProperty("cost_per_merged_pr");
    expect(row).toHaveProperty("context_efficiency");
    expect(row).toHaveProperty("run_ids");
  });

  it("AC1: metric fields may be null for runners with insufficient data", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    const nullRow = json.runners.find((r: { runner_name: string }) => r.runner_name === "codex");
    expect(nullRow.success_rate).toBeNull();
    expect(nullRow.review_fix_rate).toBeNull();
    expect(nullRow.human_review_rate).toBeNull();
    expect(nullRow.cost_per_merged_pr).toBeNull();
    expect(nullRow.context_efficiency).toBeNull();
  });

  it("AC2: passes repositoryId filter to getRunnerRunStats", async () => {
    const res = await GET(req("?repositoryId=repo-1"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ repositoryId: "repo-1" })
    );
  });

  it("AC3: passes parsed from/to Date objects to getRunnerRunStats", async () => {
    const res = await GET(req("?from=2025-01-01&to=2025-12-31"), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        from: new Date("2025-01-01"),
        to: new Date("2025-12-31"),
      })
    );
  });

  it("AC4: returns 200 { runners: [] } when no runs match filters", async () => {
    vi.mocked(getRunnerRunStats).mockResolvedValue([]);
    vi.mocked(buildRunnerScorecard).mockReturnValue([]);
    const res = await GET(req("?repositoryId=nonexistent"), {
      params: params(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runners).toEqual([]);
  });

  it("AC5: run_ids array is non-empty for runners with at least one run", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    const claudeRow = json.runners.find((r: { runner_name: string }) => r.runner_name === "claude");
    expect(Array.isArray(claudeRow.run_ids)).toBe(true);
    expect(claudeRow.run_ids.length).toBeGreaterThan(0);
  });

  it("400 when from is an invalid ISO date", async () => {
    const res = await GET(req("?from=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when to is an invalid ISO date", async () => {
    const res = await GET(req("?to=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("passes taskType filter to getRunnerRunStats", async () => {
    const res = await GET(req("?taskType=bug-fix"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ taskType: "bug-fix" })
    );
  });

  it("calls getRunnerCostStats and getRunnerContextEfficiency with all collected run_ids", async () => {
    await GET(req(), { params: params() });

    const allRunIds = ["run-1", "run-2", "run-3"];
    expect(getRunnerCostStats).toHaveBeenCalledWith(WS, allRunIds);
    expect(getRunnerContextEfficiency).toHaveBeenCalledWith(WS, allRunIds);
  });

  it("calls buildRunnerScorecard with all three aggregator outputs", async () => {
    const mockCostStats = [{ run_id: "run-1", total_cost_usd: 0.5 }];
    const mockEffStats = [{ run_id: "run-1", tokens_saved_sum: 10, token_budget_sum: 20 }];
    vi.mocked(getRunnerCostStats).mockResolvedValue(mockCostStats as never);
    vi.mocked(getRunnerContextEfficiency).mockResolvedValue(mockEffStats as never);

    await GET(req(), { params: params() });

    expect(buildRunnerScorecard).toHaveBeenCalledWith(
      sampleRunStats,
      mockCostStats,
      mockEffStats
    );
  });

  it("502 when getRunnerRunStats throws", async () => {
    vi.mocked(getRunnerRunStats).mockRejectedValue(new Error("DB down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("502 when getRunnerCostStats throws", async () => {
    vi.mocked(getRunnerCostStats).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("passes workspaceId to getRunnerRunStats", async () => {
    await GET(req(), { params: params() });
    expect(getRunnerRunStats).toHaveBeenCalledWith(WS, expect.anything());
  });

  it("from/to are undefined when not provided", async () => {
    await GET(req(), { params: params() });
    const call = vi.mocked(getRunnerRunStats).mock.calls[0][1];
    expect(call?.from).toBeUndefined();
    expect(call?.to).toBeUndefined();
  });
});
