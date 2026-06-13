import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  listCostAnomalies: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { listCostAnomalies } from "@agentrail/db-clickhouse";

const WS = "workspace-001";
const USER = "user-001";

function req(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/costs/anomalies${query}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "member-1" } as never);
  vi.mocked(listCostAnomalies).mockResolvedValue([]);
});

describe("GET /api/v1/workspaces/[workspaceId]/costs/anomalies", () => {
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

  it("200 with anomaly rows", async () => {
    vi.mocked(listCostAnomalies).mockResolvedValue([
      {
        run_id: "run-001",
        model: "claude-sonnet-4-6",
        phase: "execute",
        repository_id: "repo-001",
        cost_usd: 0.5,
        mean: 0.05,
        stddev: 0.02,
        deviation_sigmas: 22.5,
        occurred_at: "2026-06-13T00:00:00.000Z",
      },
    ]);

    const res = await GET(req(), { params: params() });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.anomalies).toHaveLength(1);
    expect(json.anomalies[0].deviation_sigmas).toBe(22.5);
  });

  it("passes optional time filters to ClickHouse helper", async () => {
    const res = await GET(
      req("?time_from=2026-06-01T00%3A00%3A00.000Z&time_to=2026-06-13T00%3A00%3A00.000Z"),
      { params: params() }
    );

    expect(res.status).toBe(200);
    expect(listCostAnomalies).toHaveBeenCalledWith(WS, {
      timeFrom: new Date("2026-06-01T00:00:00.000Z"),
      timeTo: new Date("2026-06-13T00:00:00.000Z"),
    });
  });

  it("200 with empty anomalies when ClickHouse query throws", async () => {
    vi.mocked(listCostAnomalies).mockRejectedValue(new Error("ClickHouse down"));
    const res = await GET(req(), { params: params() });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.anomalies).toEqual([]);
  });
});
