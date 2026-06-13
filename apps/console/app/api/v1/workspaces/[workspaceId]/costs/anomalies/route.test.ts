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

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/costs/anomalies${search}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleAnomalies = [
  {
    run_id: "run-1",
    model: "gpt-5.5",
    phase: "execute",
    repository_id: "repo-1",
    cost_usd: 12.5,
    mean: 3.1,
    stddev: 1.2,
    deviation_sigmas: 7.83,
    occurred_at: "2026-06-13T08:00:00.000Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(listCostAnomalies).mockResolvedValue(sampleAnomalies);
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
    expect(json.anomalies).toEqual(sampleAnomalies);
    expect(listCostAnomalies).toHaveBeenCalledWith(WS, {
      timeFrom: undefined,
      timeTo: undefined,
    });
  });

  it("200 with empty anomalies when no anomaly events exist", async () => {
    vi.mocked(listCostAnomalies).mockResolvedValue([]);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.anomalies).toEqual([]);
  });

  it("passes optional time_from and time_to filters", async () => {
    const res = await GET(
      req("?time_from=2026-06-13T08:00:00.000Z&time_to=2026-06-13T09:00:00.000Z"),
      { params: params() }
    );

    expect(res.status).toBe(200);
    const [, opts] = vi.mocked(listCostAnomalies).mock.calls[0]!;
    expect(opts).toBeDefined();
    expect(opts!.timeFrom?.toISOString()).toBe("2026-06-13T08:00:00.000Z");
    expect(opts!.timeTo?.toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("400 when time_from is not a valid ISO date", async () => {
    const res = await GET(req("?time_from=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("200 with empty anomalies when ClickHouse query fails", async () => {
    vi.mocked(listCostAnomalies).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.anomalies).toEqual([]);
  });
});
