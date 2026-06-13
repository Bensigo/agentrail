import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getCostAnomalies: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getCostAnomalies } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/costs/anomalies${query}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleAnomalies = [
  {
    run_id: "run-1",
    model: "claude-sonnet-4-6",
    phase: "execute",
    repository_id: "repo-1",
    cost_usd: 5.0,
    mean: 1.0,
    stddev: 0.5,
    deviation_sigmas: 8.0,
    occurred_at: "2026-06-12 10:00:00.000",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getCostAnomalies).mockResolvedValue(sampleAnomalies as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/costs/anomalies", () => {
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

  it("200 with anomalies array", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.anomalies).toHaveLength(1);
    expect(json.anomalies[0]).toMatchObject({
      run_id: "run-1",
      model: "claude-sonnet-4-6",
      deviation_sigmas: 8.0,
    });
    expect(getCostAnomalies).toHaveBeenCalledWith(WS, {
      timeFrom: undefined,
      timeTo: undefined,
    });
  });

  it("200 with empty array when no anomalies exist", async () => {
    vi.mocked(getCostAnomalies).mockResolvedValue([]);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.anomalies).toEqual([]);
  });

  it("forwards time_from/time_to ISO query params as Dates", async () => {
    const from = "2026-06-01T00:00:00.000Z";
    const to = "2026-06-12T00:00:00.000Z";
    const res = await GET(req(`?time_from=${from}&time_to=${to}`), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(getCostAnomalies).toHaveBeenCalledWith(WS, {
      timeFrom: new Date(from),
      timeTo: new Date(to),
    });
  });
});
