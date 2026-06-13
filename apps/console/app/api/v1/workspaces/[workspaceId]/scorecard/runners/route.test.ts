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

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getRunnerRunStats } from "@agentrail/db-postgres";
import { getRunnerCostStats, getRunnerContextEfficiency } from "@agentrail/db-clickhouse";

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

const samplePgRows = [
  {
    runner_name: "claude",
    run_ids: ["run-a", "run-b"],
    total_count: 2,
    success_count: 1,
    human_review_count: null,
    review_fix_count: 1,
  },
  {
    runner_name: "codex",
    run_ids: ["run-c"],
    total_count: 1,
    success_count: 1,
    human_review_count: null,
    review_fix_count: 0,
  },
];

const sampleCostRows = [
  { run_id: "run-a", total_cost_usd: 0.05 },
  { run_id: "run-b", total_cost_usd: 0.04 },
  { run_id: "run-c", total_cost_usd: 0.08 },
];

const sampleEffRows = [
  { run_id: "run-a", tokens_saved_sum: 4000, token_budget_sum: 16000 },
  { run_id: "run-b", tokens_saved_sum: 6000, token_budget_sum: 16000 },
  { run_id: "run-c", tokens_saved_sum: 8000, token_budget_sum: 16000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRunnerRunStats).mockResolvedValue(samplePgRows);
  vi.mocked(getRunnerCostStats).mockResolvedValue(sampleCostRows);
  vi.mocked(getRunnerContextEfficiency).mockResolvedValue(sampleEffRows);
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

  it("200 returns runners array", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.runners)).toBe(true);
    expect(json.runners).toHaveLength(2);
    expect(json.runners[0].runner_name).toBe("claude");
    expect(json.runners[1].runner_name).toBe("codex");
  });

  it("200 returns empty runners array when no data", async () => {
    vi.mocked(getRunnerRunStats).mockResolvedValue([]);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runners).toHaveLength(0);
  });

  it("passes repositoryId filter to getRunnerRunStats", async () => {
    const res = await GET(req("?repositoryId=repo-1"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ repositoryId: "repo-1" })
    );
  });

  it("passes taskType filter to getRunnerRunStats", async () => {
    const res = await GET(req("?taskType=issue"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ taskType: "issue" })
    );
  });

  it("AC3: range=7d sets a from/to window", async () => {
    const res = await GET(req("?range=7d"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) })
    );
    const call = vi.mocked(getRunnerRunStats).mock.calls[0][1]!;
    const diffMs = call.to!.getTime() - call.from!.getTime();
    expect(diffMs).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);
  });

  it("range=all passes from=epoch", async () => {
    const res = await GET(req("?range=all"), { params: params() });
    expect(res.status).toBe(200);
    const call = vi.mocked(getRunnerRunStats).mock.calls[0][1]!;
    expect(call.from!.getTime()).toBe(0);
  });

  it("400 when range is invalid", async () => {
    const res = await GET(req("?range=invalid"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when from is invalid date", async () => {
    const res = await GET(req("?from=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when to is invalid date", async () => {
    const res = await GET(req("?to=bad"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("502 on Postgres error", async () => {
    vi.mocked(getRunnerRunStats).mockRejectedValue(new Error("PG down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("502 on ClickHouse cost error", async () => {
    vi.mocked(getRunnerCostStats).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(502);
  });

  it("metrics are correctly computed: success_rate", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    const claude = json.runners.find((r: { runner_name: string }) => r.runner_name === "claude");
    // success_count=1, total_count=2 → 0.5
    expect(claude.success_rate).toBeCloseTo(0.5);
  });

  it("metrics: cost_per_merged_pr = total_cost / success_count", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    const claude = json.runners.find((r: { runner_name: string }) => r.runner_name === "claude");
    // (0.05 + 0.04) / 1 = 0.09
    expect(claude.cost_per_merged_pr).toBeCloseTo(0.09);
  });

  it("metrics: context_efficiency = tokens_saved / token_budget", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    const claude = json.runners.find((r: { runner_name: string }) => r.runner_name === "claude");
    // (4000 + 6000) / (16000 + 16000) = 0.3125
    expect(claude.context_efficiency).toBeCloseTo(0.3125);
  });

  it("AC5: passes explicit from/to when no range given", async () => {
    const res = await GET(req("?from=2026-01-01&to=2026-06-01"), { params: params() });
    expect(res.status).toBe(200);
    expect(getRunnerRunStats).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        from: new Date("2026-01-01"),
        to: new Date("2026-06-01"),
      })
    );
  });
});
