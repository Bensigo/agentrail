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

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/telemetry-health`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

const sampleSignals = [
  { signal: "run_start", present: true, missing_since: null },
  { signal: "context_pack", present: true, missing_since: null },
  { signal: "cost_event", present: false, missing_since: "2026-06-13T08:00:00.000Z" },
  { signal: "review_gate", present: true, missing_since: null },
  { signal: "failure_event", present: false, missing_since: "2026-06-13T08:00:00.000Z" },
  { signal: "memory_items", present: true, missing_since: null },
  { signal: "index_snapshot", present: true, missing_since: null },
  { signal: "outbox_flush", present: false, missing_since: "2026-06-13T08:00:00.000Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getRunTelemetryHealth).mockResolvedValue(sampleSignals as never);
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

  it("200 with exactly eight signal objects", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.signals).toHaveLength(8);
    for (const signal of json.signals) {
      expect(signal).toHaveProperty("signal");
      expect(signal).toHaveProperty("present");
      expect(signal).toHaveProperty("missing_since");
    }
    expect(getRunTelemetryHealth).toHaveBeenCalledWith(WS, RUN);
  });

  it("200 with default absent signals when ClickHouse has no rows", async () => {
    vi.mocked(getRunTelemetryHealth).mockResolvedValue(
      sampleSignals.map((signal) => ({
        signal: signal.signal,
        present: false,
        missing_since: null,
      })) as never
    );

    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.signals).toHaveLength(8);
    expect(json.signals.every((signal: { present: boolean }) => signal.present === false)).toBe(true);
    expect(json.signals.every((signal: { missing_since: string | null }) => signal.missing_since === null)).toBe(true);
  });
});
