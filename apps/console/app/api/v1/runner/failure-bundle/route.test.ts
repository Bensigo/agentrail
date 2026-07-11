import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getRun: vi.fn(),
  getReviewGatesForRun: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getFailuresForRun: vi.fn(),
  getRunEventsByRunId: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { GET } from "./route";
import {
  getRun,
  getReviewGatesForRun,
  touchApiKeyLastUsed,
} from "@agentrail/db-postgres";
import {
  getFailuresForRun,
  getRunEventsByRunId,
} from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "k1";
const TEAM = "t1";
const RUN = "run-abc";

function req(runId?: string, withAuth = true): NextRequest {
  const qs = runId === undefined ? "" : `?run_id=${encodeURIComponent(runId)}`;
  return new NextRequest(`http://localhost/api/v1/runner/failure-bundle${qs}`, {
    method: "GET",
    headers: withAuth ? { Authorization: "Bearer ar_test" } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
  } as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
  vi.mocked(getRun).mockResolvedValue(null as never);
  vi.mocked(getReviewGatesForRun).mockResolvedValue([] as never);
  vi.mocked(getFailuresForRun).mockResolvedValue([] as never);
  vi.mocked(getRunEventsByRunId).mockResolvedValue([] as never);
});

describe("GET /api/v1/runner/failure-bundle (#1146 AC3)", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await GET(req(RUN, false));
    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("400 when run_id is missing", async () => {
    const res = await GET(req(undefined));
    expect(res.status).toBe(400);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("404 when the run_id resolves to nothing in the workspace", async () => {
    const res = await GET(req(RUN));
    expect(res.status).toBe(404);
  });

  it("returns the full bundle when the run exists", async () => {
    vi.mocked(getRun).mockResolvedValue({ id: RUN, workspaceId: WS } as never);
    vi.mocked(getReviewGatesForRun).mockResolvedValue([
      { id: "g1", runId: RUN, verdict: "fail" },
    ] as never);
    vi.mocked(getFailuresForRun).mockResolvedValue([
      {
        run_id: RUN,
        failure_type: "objective_gate",
        evidence: "E   AssertionError: expected 3 got 4",
        phase: "verify",
      },
    ] as never);
    vi.mocked(getRunEventsByRunId).mockResolvedValue([
      { run_id: RUN, event_type: "gate_red", phase: "lifecycle" },
    ] as never);

    const res = await GET(req(RUN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: RUN });
    expect(body.failure_events).toHaveLength(1);
    expect(body.failure_events[0].evidence).toContain("AssertionError");
    expect(body.review_gates).toHaveLength(1);
    expect(body.timeline).toHaveLength(1);
  });

  it("returns 200 when only failures exist (no run row yet)", async () => {
    vi.mocked(getFailuresForRun).mockResolvedValue([
      { run_id: RUN, failure_type: "execution_error", evidence: "boom" },
    ] as never);
    const res = await GET(req(RUN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBeNull();
    expect(body.failure_events).toHaveLength(1);
  });

  it("scopes every read to the key's workspace, not the query", async () => {
    vi.mocked(getRun).mockResolvedValue({ id: RUN } as never);
    await GET(req(RUN));
    expect(getRun).toHaveBeenCalledWith(WS, RUN);
    expect(getReviewGatesForRun).toHaveBeenCalledWith(WS, RUN);
    expect(getFailuresForRun).toHaveBeenCalledWith(WS, RUN);
    expect(getRunEventsByRunId).toHaveBeenCalledWith(WS, RUN);
  });

  it("502 when a backing store errors", async () => {
    vi.mocked(getFailuresForRun).mockRejectedValue(new Error("clickhouse down"));
    const res = await GET(req(RUN));
    expect(res.status).toBe(502);
  });
});
