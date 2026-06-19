import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getWorkspace: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getQualityMetrics: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getWorkspace } from "@agentrail/db-postgres";
import { getQualityMetrics } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(search = "") {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/context-quality/metrics${search}`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS });
}

const sampleResult = {
  insufficient_data: false,
  run_count: 8,
  series: [
    {
      date: "2026-06-01",
      precision_at_budget: 0.9,
      citation_coverage: 0.8,
      stale_count: 2,
      denied_count: 1,
      run_count: 1,
    },
  ],
  latest: {
    precision_at_budget: 0.9,
    citation_coverage: 0.8,
    stale_count: 2,
    denied_count: 1,
  },
  latest_date: "2026-06-01",
  baseline: {
    precision_at_budget: 0.85,
    citation_coverage: 0.75,
    stale_count: 3,
    denied_count: 2,
  },
  regression: {
    precision_at_budget: false,
    citation_coverage: false,
    stale_count: true,
    denied_count: true,
  },
};

const insufficientResult = {
  insufficient_data: true,
  run_count: 2,
  series: [],
  latest: {
    precision_at_budget: null,
    citation_coverage: null,
    stale_count: null,
    denied_count: null,
  },
  latest_date: null,
  baseline: {
    precision_at_budget: null,
    citation_coverage: null,
    stale_count: null,
    denied_count: null,
  },
  regression: {
    precision_at_budget: false,
    citation_coverage: false,
    stale_count: false,
    denied_count: false,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getWorkspace).mockResolvedValue({ id: WS, baselineWindowDays: 30 } as never);
  vi.mocked(getQualityMetrics).mockResolvedValue(sampleResult);
});

describe("GET /api/v1/workspaces/[workspaceId]/context-quality/metrics", () => {
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

  it("200 with valid QualityMetricsResult", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.insufficient_data).toBe(false);
    expect(json.series).toHaveLength(1);
    expect(getQualityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS })
    );
  });

  it("200 with insufficient_data: true when fewer than 5 runs", async () => {
    vi.mocked(getQualityMetrics).mockResolvedValue(insufficientResult);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.insufficient_data).toBe(true);
  });

  it("400 when windowDays is non-numeric", async () => {
    const res = await GET(req("?windowDays=abc"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when windowDays is a float", async () => {
    const res = await GET(req("?windowDays=7.5"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when windowDays is below 7", async () => {
    const res = await GET(req("?windowDays=5"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when windowDays is above 90", async () => {
    const res = await GET(req("?windowDays=91"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when from is invalid ISO date", async () => {
    const res = await GET(req("?from=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("400 when to is invalid ISO date", async () => {
    const res = await GET(req("?to=not-a-date"), { params: params() });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("502 on ClickHouse error", async () => {
    vi.mocked(getQualityMetrics).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("passes repositoryId when provided", async () => {
    const res = await GET(req("?repositoryId=repo-1"), { params: params() });
    expect(res.status).toBe(200);
    expect(getQualityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" })
    );
  });

  it("uses windowDays=7 boundary correctly", async () => {
    const res = await GET(req("?windowDays=7"), { params: params() });
    expect(res.status).toBe(200);
    expect(getQualityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 7 })
    );
  });

  it("uses windowDays=90 boundary correctly", async () => {
    const res = await GET(req("?windowDays=90"), { params: params() });
    expect(res.status).toBe(200);
    expect(getQualityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 90 })
    );
  });

  it("AC3: uses workspace baseline_window_days as default when windowDays param is absent", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({ id: WS, baselineWindowDays: 45 } as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    expect(getQualityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 45 })
    );
    const json = await res.json();
    expect(json.baseline_window_days).toBe(45);
  });

  it("AC4: caller-supplied windowDays=7 overrides workspace default of 45", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({ id: WS, baselineWindowDays: 45 } as never);
    const res = await GET(req("?windowDays=7"), { params: params() });
    expect(res.status).toBe(200);
    expect(getQualityMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 7 })
    );
    const json = await res.json();
    expect(json.baseline_window_days).toBe(45);
  });

  it("AC5: returns HTTP 200 with insufficient_data: true when aggregator reports < 5 runs", async () => {
    vi.mocked(getQualityMetrics).mockResolvedValue(insufficientResult);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.insufficient_data).toBe(true);
    expect(json.baseline_window_days).toBe(30);
  });

  it("AC6: response includes baseline_window_days from workspace for UI selector initialisation", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.baseline_window_days).toBe(30);
  });

  it("404 when workspace does not exist", async () => {
    vi.mocked(getWorkspace).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
