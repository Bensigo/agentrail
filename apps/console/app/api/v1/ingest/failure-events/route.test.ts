import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertFailureEvents: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertFailureEvents } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/failure-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  repository_id: REPO,
  run_id: "run-abc",
  failure_type: "phase_failure",
  message: "execute phase exited with status 1",
  phase: "execute",
  occurred_at: "2026-06-12T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({ workspaceId: WS, apiKeyId: KEY, teamId: TEAM } as never);
  vi.mocked(getRepository).mockResolvedValue({ id: REPO, workspaceId: WS } as never);
  vi.mocked(insertFailureEvents).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/failure-events", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + accepted count on valid single event", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(insertFailureEvents).toHaveBeenCalledWith([
      {
        workspace_id: WS,
        run_id: valid.run_id,
        repository_id: valid.repository_id,
        failure_type: valid.failure_type,
        message: valid.message,
        evidence: "",
        phase: valid.phase,
        severity: "error",
        occurred_at: valid.occurred_at,
      },
    ]);
  });

  it("202 with optional fields (evidence + severity)", async () => {
    const withOptional = { ...valid, evidence: '{"exit":1}', severity: "critical" };
    const res = await POST(req(withOptional));
    expect(res.status).toBe(202);
    const call = vi.mocked(insertFailureEvents).mock.calls[0][0][0];
    expect(call.evidence).toBe('{"exit":1}');
    expect(call.severity).toBe("critical");
  });

  it("404 when repo not in the key's workspace", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(insertFailureEvents).not.toHaveBeenCalled();
  });

  it("400 on malformed body (missing required field)", async () => {
    const res = await POST(req({ repository_id: REPO, run_id: "run-abc" }));
    expect(res.status).toBe(400);
  });

  it("400 on batch exceeding 100 items", async () => {
    const batch = Array.from({ length: 101 }, () => ({ ...valid }));
    const res = await POST(req(batch));
    expect(res.status).toBe(400);
  });

  it("202 on a batch of 2 events", async () => {
    vi.mocked(insertFailureEvents).mockResolvedValue(2);
    const res = await POST(req([valid, { ...valid, failure_type: "timeout" }]));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
  });
});
