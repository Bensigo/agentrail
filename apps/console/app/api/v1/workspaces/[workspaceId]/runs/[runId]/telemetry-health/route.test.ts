import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getRunTelemetryHealth: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRunTelemetryHealth } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "00000000-0000-0000-0000-000000000002";
const USER = "user-1";

const SIGNAL_NAMES = [
  "run_start",
  "context_pack",
  "cost_event",
  "review_gate",
  "failure_event",
  "memory_items",
  "index_snapshot",
  "outbox_flush",
];

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/telemetry-health`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

const presentSignals = SIGNAL_NAMES.map((signal) => ({
  signal,
  present: true,
  missing_since: null,
}));

const absentSignals = SIGNAL_NAMES.map((signal) => ({
  signal,
  present: false,
  missing_since: null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRunTelemetryHealth).mockResolvedValue(presentSignals as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/telemetry-health", () => {
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

  it("200 with a signals array of exactly 8 shaped items", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.signals).toHaveLength(8);
    for (const item of json.signals) {
      expect(item).toHaveProperty("signal");
      expect(item).toHaveProperty("present");
      expect(item).toHaveProperty("missing_since");
    }
    expect(json.signals.map((s: { signal: string }) => s.signal)).toEqual(
      SIGNAL_NAMES
    );
    expect(getRunTelemetryHealth).toHaveBeenCalledWith(WS, RUN);
  });

  it("200 with all-absent signals (not 500) when ClickHouse has no data", async () => {
    vi.mocked(getRunTelemetryHealth).mockResolvedValue(absentSignals as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.signals).toHaveLength(8);
    expect(json.signals.every((s: { present: boolean }) => s.present === false)).toBe(
      true
    );
  });
});
