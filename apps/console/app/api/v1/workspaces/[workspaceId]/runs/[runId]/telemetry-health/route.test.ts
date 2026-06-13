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
  defaultTelemetryHealthSignals: vi.fn(() => [
    { signal: "run_start", present: false, missing_since: null },
    { signal: "context_pack", present: false, missing_since: null },
    { signal: "cost_event", present: false, missing_since: null },
    { signal: "review_gate", present: false, missing_since: null },
    { signal: "failure_event", present: false, missing_since: null },
    { signal: "memory_items", present: false, missing_since: null },
    { signal: "index_snapshot", present: false, missing_since: null },
    { signal: "outbox_flush", present: false, missing_since: null },
  ]),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getRunTelemetryHealth } from "@agentrail/db-clickhouse";

const WS = "workspace-001";
const RUN = "run-001";
const USER = "user-001";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/telemetry-health`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "member-1" } as never);
  vi.mocked(getRunTelemetryHealth).mockResolvedValue([
    { signal: "run_start", present: true, missing_since: null },
    { signal: "context_pack", present: true, missing_since: null },
    { signal: "cost_event", present: false, missing_since: "2026-06-13T00:00:00.000Z" },
    { signal: "review_gate", present: true, missing_since: null },
    { signal: "failure_event", present: true, missing_since: null },
    { signal: "memory_items", present: true, missing_since: null },
    { signal: "index_snapshot", present: true, missing_since: null },
    { signal: "outbox_flush", present: true, missing_since: null },
  ]);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/telemetry-health", () => {
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

  it("200 with eight telemetry signals", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.signals).toHaveLength(8);
    expect(json.signals[2]).toEqual({
      signal: "cost_event",
      present: false,
      missing_since: "2026-06-13T00:00:00.000Z",
    });
    expect(getRunTelemetryHealth).toHaveBeenCalledWith(WS, RUN);
  });

  it("200 with default signals when ClickHouse query throws", async () => {
    vi.mocked(getRunTelemetryHealth).mockRejectedValue(new Error("ClickHouse down"));
    const res = await GET(req(), { params: params() });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.signals).toHaveLength(8);
    expect(json.signals.every((signal: { present: boolean }) => signal.present === false)).toBe(true);
  });
});
