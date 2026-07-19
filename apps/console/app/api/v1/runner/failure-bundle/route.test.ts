import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getRunById: vi.fn(),
  getReviewGatesForRun: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getFailuresForRun: vi.fn(),
  getRunEventsByRunId: vi.fn(),
}));

import { GET } from "./route";
import { getRunById, getReviewGatesForRun } from "@agentrail/db-postgres";
import {
  getFailuresForRun,
  getRunEventsByRunId,
} from "@agentrail/db-clickhouse";

const mockGetRunById = vi.mocked(getRunById);
const mockGetGates = vi.mocked(getReviewGatesForRun);
const mockGetFailures = vi.mocked(getFailuresForRun);
const mockGetEvents = vi.mocked(getRunEventsByRunId);

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "run-abc";

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key — the workspace it used to read straight off that bearer
// (auth.workspaceId) is now resolved from the RUN ROW ITSELF via the new
// unscoped-by-PK getRunById (runs.id is a server-minted, non-guessable
// uuid — see that function's own doc-comment), never from caller input.
// Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(opts: { runId?: string; token?: string } = {}): NextRequest {
  const { runId, token } = opts;
  const qs = runId === undefined ? "" : `?run_id=${encodeURIComponent(runId)}`;
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(`http://localhost/api/v1/runner/failure-bundle${qs}`, {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockGetRunById.mockResolvedValue(null as never);
  mockGetGates.mockResolvedValue([] as never);
  mockGetFailures.mockResolvedValue([] as never);
  mockGetEvents.mockResolvedValue([] as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/failure-bundle (#1146 AC3)", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret, 2026-07-20)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected, and never touches the db", async () => {
      delete process.env[ENV_KEY];

      const res = await GET(req({ runId: RUN, token: SECRET }));

      expect(res.status).toBe(401);
      expect(mockGetRunById).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent", async () => {
      const res = await GET(req({ runId: RUN }));
      expect(res.status).toBe(401);
      expect(mockGetRunById).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await GET(req({ runId: RUN, token: "wrong-secret" }));
      expect(res.status).toBe(401);
      expect(mockGetRunById).not.toHaveBeenCalled();
    });
  });

  it("400 when run_id is missing", async () => {
    const res = await GET(req({ token: SECRET }));
    expect(res.status).toBe(400);
    expect(mockGetRunById).not.toHaveBeenCalled();
  });

  it("404 when the run_id resolves to no run at all", async () => {
    const res = await GET(req({ runId: RUN, token: SECRET }));
    expect(res.status).toBe(404);
    expect(mockGetGates).not.toHaveBeenCalled();
    expect(mockGetFailures).not.toHaveBeenCalled();
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it("BEHAVIOR CHANGE (accepted, per the central-secret design): a run_id with failure_events but no Postgres runs row now 404s — previously this returned 200 with run:null, scoped by the bearer's OWN workspace. There is no longer a bearer workspace to fall back on; workspace is derived SOLELY from the run row, so no run row means no trusted tenant to scope a ClickHouse read by. In practice the triage subagent only ever calls this for a hosted run that already has its runs row (created at claim time, well before a failure could be reported), so this narrowing is not expected to bite a real caller.", async () => {
    mockGetRunById.mockResolvedValue(null as never);
    mockGetFailures.mockResolvedValue([
      { run_id: RUN, failure_type: "execution_error", evidence: "boom" },
    ] as never);

    const res = await GET(req({ runId: RUN, token: SECRET }));

    expect(res.status).toBe(404);
  });

  it("returns the full bundle when the run exists, scoping every downstream read to the RUN ROW'S OWN workspaceId (never a caller-supplied one — there is no such input)", async () => {
    mockGetRunById.mockResolvedValue({ id: RUN, workspaceId: WS } as never);
    mockGetGates.mockResolvedValue([
      { id: "g1", runId: RUN, verdict: "fail" },
    ] as never);
    mockGetFailures.mockResolvedValue([
      {
        run_id: RUN,
        failure_type: "objective_gate",
        evidence: "E   AssertionError: expected 3 got 4",
        phase: "verify",
      },
    ] as never);
    mockGetEvents.mockResolvedValue([
      { run_id: RUN, event_type: "gate_red", phase: "lifecycle" },
    ] as never);

    const res = await GET(req({ runId: RUN, token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: RUN });
    expect(body.failure_events).toHaveLength(1);
    expect(body.failure_events[0].evidence).toContain("AssertionError");
    expect(body.review_gates).toHaveLength(1);
    expect(body.timeline).toHaveLength(1);

    expect(mockGetRunById).toHaveBeenCalledWith(RUN);
    expect(mockGetGates).toHaveBeenCalledWith(WS, RUN);
    expect(mockGetFailures).toHaveBeenCalledWith(WS, RUN);
    expect(mockGetEvents).toHaveBeenCalledWith(WS, RUN);
  });

  it("returns 200 with empty arrays for a real run that simply has no failures/gates/timeline yet (distinct from the 404 unknown-run case)", async () => {
    mockGetRunById.mockResolvedValue({ id: RUN, workspaceId: WS } as never);

    const res = await GET(req({ runId: RUN, token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: RUN });
    expect(body.failure_events).toEqual([]);
    expect(body.review_gates).toEqual([]);
    expect(body.timeline).toEqual([]);
  });

  it("uses a DIFFERENT run's own workspaceId, not some other value — the run row is the ONLY source of the workspace scope", async () => {
    const otherWs = "00000000-0000-0000-0000-000000000099";
    mockGetRunById.mockResolvedValue({ id: RUN, workspaceId: otherWs } as never);

    await GET(req({ runId: RUN, token: SECRET }));

    expect(mockGetGates).toHaveBeenCalledWith(otherWs, RUN);
    expect(mockGetFailures).toHaveBeenCalledWith(otherWs, RUN);
    expect(mockGetEvents).toHaveBeenCalledWith(otherWs, RUN);
  });

  it("502 when the run lookup itself errors", async () => {
    mockGetRunById.mockRejectedValue(new Error("pg down"));
    const res = await GET(req({ runId: RUN, token: SECRET }));
    expect(res.status).toBe(502);
  });

  it("502 when a downstream backing store errors", async () => {
    mockGetRunById.mockResolvedValue({ id: RUN, workspaceId: WS } as never);
    mockGetFailures.mockRejectedValue(new Error("clickhouse down"));
    const res = await GET(req({ runId: RUN, token: SECRET }));
    expect(res.status).toBe(502);
  });
});
