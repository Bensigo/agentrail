import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listRuns: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", async (importActual) => {
  const actual = await importActual<typeof import("@agentrail/db-clickhouse")>();
  return {
    getCacheReadCreationRatio: vi.fn(),
    getRunCostTotals: vi.fn(),
    getAgentCostBreakdown: vi.fn(),
    computeCostPerIssueToGreen: actual.computeCostPerIssueToGreen,
  };
});

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";
import {
  getCacheReadCreationRatio,
  getRunCostTotals,
  getAgentCostBreakdown,
} from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/costs/meter${search}`,
    { method: "GET" }
  );
}
function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  // Issue "feat/x" reached green via two runs (cheap fail then escalated green);
  // issue "feat/y" never reached green.
  vi.mocked(listRuns).mockResolvedValue([
    { id: "r1", branch: "feat/x", status: "failed" },
    { id: "r2", branch: "feat/x", status: "success" },
    { id: "r3", branch: "feat/y", status: "failed" },
  ] as never);
  vi.mocked(getRunCostTotals).mockResolvedValue([
    { run_id: "r1", cost_usd: 1.0 },
    { run_id: "r2", cost_usd: 2.0 },
    { run_id: "r3", cost_usd: 4.0 },
  ]);
  vi.mocked(getCacheReadCreationRatio).mockResolvedValue({
    cacheReadTokens: 1000,
    cacheCreationTokens: 400,
    ratio: 2.5,
  });
  vi.mocked(getAgentCostBreakdown).mockResolvedValue([
    { agent: "claude", totalCostUsd: 7.0, eventCount: 12 },
  ]);
});

describe("GET /api/v1/workspaces/[workspaceId]/costs/meter", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("computes Cost-per-Issue-to-Green over green issues only (AC1)", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.costPerIssueToGreen.greenIssueCount).toBe(1);
    // feat/x = r1 (1.0) + r2 (2.0) = 3.0; feat/y excluded (never green)
    expect(json.costPerIssueToGreen.avgCostUsd).toBeCloseTo(3.0);
    expect(json.costPerIssueToGreen.issues).toHaveLength(1);
    expect(json.costPerIssueToGreen.issues[0].costUsd).toBeCloseTo(3.0);
  });

  it("surfaces the cache read-to-creation ratio (AC2)", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    expect(json.cacheRatio.ratio).toBeCloseTo(2.5);
    expect(json.cacheRatio.cacheReadTokens).toBe(1000);
    expect(json.cacheRatio.cacheCreationTokens).toBe(400);
  });

  it("returns agent cost breakdown without a savings field", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    expect(json.agentBreakdown).toBeDefined();
    expect(json.agentBreakdown[0]).not.toHaveProperty("dollarsSaved");
    expect(json.agentBreakdown[0]).not.toHaveProperty("savings");
  });

  it("400 when time_from is invalid", async () => {
    const res = await GET(req("?time_from=nope"), { params: params() });
    expect(res.status).toBe(400);
  });

  it("200 with empty/null metrics when ClickHouse fails", async () => {
    vi.mocked(getCacheReadCreationRatio).mockRejectedValue(new Error("CH down"));
    vi.mocked(getRunCostTotals).mockRejectedValue(new Error("CH down"));
    vi.mocked(getAgentCostBreakdown).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.costPerIssueToGreen.avgCostUsd).toBeNull();
    expect(json.cacheRatio.ratio).toBeNull();
    expect(json.agentBreakdown).toEqual([]);
  });
});
