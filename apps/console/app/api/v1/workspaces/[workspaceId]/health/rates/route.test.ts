import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listRuns: vi.fn(),
}));
// Use the real pure computation so the route's projection is exercised end-to-end.
vi.mock("@agentrail/db-clickhouse", async (importActual) => {
  const actual = await importActual<typeof import("@agentrail/db-clickhouse")>();
  return { computeHealthRates: actual.computeHealthRates };
});

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/health/rates`, {
    method: "GET",
  });
}
function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/health/rates", () => {
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

  it("computes accept rate (green ÷ attempted) and escalation rate (AC1/AC2)", async () => {
    // feat/a: success → green. feat/b: success → green. feat/c: success → green.
    // feat/d: two failed attempts (budget=2 exhausted) → escalated-to-human.
    vi.mocked(listRuns).mockResolvedValue([
      { id: "r1", branch: "feat/a", status: "success" },
      { id: "r2", branch: "feat/b", status: "success" },
      { id: "r3", branch: "feat/c", status: "success" },
      { id: "r4", branch: "feat/d", status: "failed" },
      { id: "r5", branch: "feat/d", status: "failed" },
    ] as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rates.attempted).toBe(4);
    expect(json.rates.green).toBe(3);
    expect(json.rates.escalated).toBe(1);
    expect(json.rates.acceptRate).toBeCloseTo(0.75);
    expect(json.rates.escalationRate).toBeCloseTo(0.25);
    expect(json.rates.belowHealthLine).toBe(false);
  });

  it("accept rate CAN display below the 50% health line (falsifiable, AC1)", async () => {
    // 1 green vs 3 escalated — a losing loop.
    vi.mocked(listRuns).mockResolvedValue([
      { id: "r1", branch: "feat/a", status: "success" },
      { id: "r2", branch: "feat/b", status: "failed" },
      { id: "r3", branch: "feat/b", status: "failed" },
      { id: "r4", branch: "feat/c", status: "failed" },
      { id: "r5", branch: "feat/c", status: "failed" },
      { id: "r6", branch: "feat/d", status: "failed" },
      { id: "r7", branch: "feat/d", status: "failed" },
    ] as never);
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    expect(json.rates.acceptRate).toBeCloseTo(0.25);
    expect(json.rates.acceptRate).toBeLessThan(0.5);
    expect(json.rates.belowHealthLine).toBe(true);
  });

  it("excludes in-flight issues (single failure with budget remaining) from attempted", async () => {
    vi.mocked(listRuns).mockResolvedValue([
      { id: "r1", branch: "feat/a", status: "success" },
      { id: "r2", branch: "feat/b", status: "running" },
      { id: "r3", branch: "feat/c", status: "failed" }, // 1 fail, budget remaining → in-flight
    ] as never);
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    expect(json.rates.attempted).toBe(1);
    expect(json.rates.acceptRate).toBeCloseTo(1.0);
  });

  it("returns null rates when there are no runs", async () => {
    vi.mocked(listRuns).mockResolvedValue([] as never);
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    expect(json.rates.attempted).toBe(0);
    expect(json.rates.acceptRate).toBeNull();
    expect(json.rates.escalationRate).toBeNull();
  });

  it("200 with empty rates when the runs read model fails", async () => {
    vi.mocked(listRuns).mockRejectedValue(new Error("db down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.rates.acceptRate).toBeNull();
  });
});
