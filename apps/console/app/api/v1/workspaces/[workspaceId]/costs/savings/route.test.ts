import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  aggregateWorkspaceSavings: vi.fn(),
  getAgentSavingsBreakdown: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { aggregateWorkspaceSavings, getAgentSavingsBreakdown } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/costs/savings${search}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleSavings = {
  tokensSaved: 500_000,
  dollarsSaved: 1.5,
  model: "claude-sonnet-4-5",
  ratePerMtok: 3.0,
  estimateFlag: true as const,
};

const sampleBreakdown = [
  { agent: "claude" as const, totalCostUsd: 10.0, dollarsSaved: 1.2, eventCount: 50 },
  { agent: "codex" as const, totalCostUsd: 5.0, dollarsSaved: 0.3, eventCount: 20 },
  { agent: "cursor" as const, totalCostUsd: 2.0, dollarsSaved: 0.0, eventCount: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(aggregateWorkspaceSavings).mockResolvedValue(sampleSavings);
  vi.mocked(getAgentSavingsBreakdown).mockResolvedValue(sampleBreakdown);
});

describe("GET /api/v1/workspaces/[workspaceId]/costs/savings", () => {
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

  it("200 with happy-path response shape", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();

    // savings object
    expect(json.savings).toMatchObject({
      tokensSaved: 500_000,
      dollarsSaved: 1.5,
      model: "claude-sonnet-4-5",
      ratePerMtok: 3.0,
      estimateFlag: true,
    });

    // agentBreakdown always has claude/codex/cursor
    expect(json.agentBreakdown).toHaveLength(3);
    const agents = json.agentBreakdown.map((r: { agent: string }) => r.agent);
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
    expect(agents).toContain("cursor");

    expect(aggregateWorkspaceSavings).toHaveBeenCalledWith(WS, {
      timeFrom: undefined,
      timeTo: undefined,
    });
    expect(getAgentSavingsBreakdown).toHaveBeenCalledWith(WS, {
      timeFrom: undefined,
      timeTo: undefined,
    });
  });

  it("estimateFlag is always true in savings object", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    expect(json.savings.estimateFlag).toBe(true);
    expect(json.savings.model).toBe("claude-sonnet-4-5");
    expect(json.savings.ratePerMtok).toBe(3.0);
  });

  it("empty workspace returns zero-filled agentBreakdown with all three agents", async () => {
    vi.mocked(aggregateWorkspaceSavings).mockResolvedValue({
      tokensSaved: 0,
      dollarsSaved: 0,
      model: "claude-sonnet-4-5",
      ratePerMtok: 3.0,
      estimateFlag: true,
    });
    vi.mocked(getAgentSavingsBreakdown).mockResolvedValue([
      { agent: "claude", totalCostUsd: 0, dollarsSaved: 0, eventCount: 0 },
      { agent: "codex", totalCostUsd: 0, dollarsSaved: 0, eventCount: 0 },
      { agent: "cursor", totalCostUsd: 0, dollarsSaved: 0, eventCount: 0 },
    ]);

    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.savings.tokensSaved).toBe(0);
    expect(json.savings.dollarsSaved).toBe(0);
    expect(json.agentBreakdown).toHaveLength(3);
    for (const row of json.agentBreakdown) {
      expect(row.totalCostUsd).toBe(0);
      expect(row.dollarsSaved).toBe(0);
      expect(row.eventCount).toBe(0);
    }
  });

  it("passes time_from and time_to filters to both queries", async () => {
    const res = await GET(
      req("?time_from=2026-06-01T00:00:00.000Z&time_to=2026-06-15T00:00:00.000Z"),
      { params: params() }
    );
    expect(res.status).toBe(200);

    const [, savingsOpts] = vi.mocked(aggregateWorkspaceSavings).mock.calls[0]!;
    expect(savingsOpts?.timeFrom?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(savingsOpts?.timeTo?.toISOString()).toBe("2026-06-15T00:00:00.000Z");

    const [, breakdownOpts] = vi.mocked(getAgentSavingsBreakdown).mock.calls[0]!;
    expect(breakdownOpts?.timeFrom?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(breakdownOpts?.timeTo?.toISOString()).toBe("2026-06-15T00:00:00.000Z");
  });

  it("400 when time_from is not a valid ISO date", async () => {
    const res = await GET(req("?time_from=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("200 with zero-filled response when ClickHouse queries fail", async () => {
    vi.mocked(aggregateWorkspaceSavings).mockRejectedValue(new Error("CH down"));
    vi.mocked(getAgentSavingsBreakdown).mockRejectedValue(new Error("CH down"));

    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.savings.tokensSaved).toBe(0);
    expect(json.savings.estimateFlag).toBe(true);
    expect(json.agentBreakdown).toHaveLength(3);
    const agents = json.agentBreakdown.map((r: { agent: string }) => r.agent);
    expect(agents).toEqual(["claude", "codex", "cursor"]);
  });
});
