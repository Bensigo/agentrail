import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getRunCosts: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRunCosts } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "00000000-0000-0000-0000-000000000002";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/costs`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

const sampleRows = [
  {
    phase: "plan",
    model: "claude-sonnet-4-6",
    input_tokens: 100,
    output_tokens: 50,
    cache_tokens: 25,
    tokens: 175,
    cost_usd: 0.001,
    occurred_at: "2026-06-12 10:00:00.000",
  },
  {
    phase: "execute",
    model: "claude-sonnet-4-6",
    input_tokens: 200,
    output_tokens: 80,
    cache_tokens: 40,
    tokens: 320,
    cost_usd: 0.002,
    occurred_at: "2026-06-12 10:05:00.000",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRunCosts).mockResolvedValue(sampleRows);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/costs", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when user not a member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("200 with rows and correct totals", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rows).toHaveLength(2);
    expect(json.totals).toEqual({
      total_cost_usd: 0.003,
      input_tokens: 300,
      output_tokens: 130,
      cache_tokens: 65,
      tokens: 495,
    });
    expect(getRunCosts).toHaveBeenCalledWith(WS, RUN);
  });

  it("200 with empty rows when no cost events", async () => {
    vi.mocked(getRunCosts).mockResolvedValue([]);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rows).toHaveLength(0);
    expect(json.totals.total_cost_usd).toBe(0);
  });
});
