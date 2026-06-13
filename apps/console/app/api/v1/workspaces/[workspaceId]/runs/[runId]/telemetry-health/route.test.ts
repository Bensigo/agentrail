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

function presentSignals(present: boolean, missingSince: string | null) {
  return SIGNAL_NAMES.map((signal) => ({
    signal,
    present,
    missing_since: present ? null : missingSince,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRunTelemetryHealth).mockResolvedValue(
    presentSignals(true, null)
  );
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

  it("200 with exactly 8 signals carrying signal/present/missing_since", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.signals).toHaveLength(8);
    for (const s of json.signals) {
      expect(s).toHaveProperty("signal");
      expect(s).toHaveProperty("present");
      expect(s).toHaveProperty("missing_since");
    }
    expect(json.signals.map((s: { signal: string }) => s.signal)).toEqual(
      SIGNAL_NAMES
    );
    expect(getRunTelemetryHealth).toHaveBeenCalledWith(WS, RUN);
  });

  it("200 with 8 all-absent signals when ClickHouse has no data for the run", async () => {
    vi.mocked(getRunTelemetryHealth).mockResolvedValue(
      presentSignals(false, null)
    );
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.signals).toHaveLength(8);
    expect(json.signals.every((s: { present: boolean }) => !s.present)).toBe(
      true
    );
  });

  it("500 when the telemetry query throws (no silent 200)", async () => {
    vi.mocked(getRunTelemetryHealth).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(500);
  });
});
