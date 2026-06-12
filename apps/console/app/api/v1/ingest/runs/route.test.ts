import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  upsertRun: vi.fn(),
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { upsertRun, getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";
const RUN_ID = "00000000-0000-0000-0000-000000000099";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  id: RUN_ID,
  repository_id: REPO,
  agent: "claude-code",
  branch: "main",
  status: "running",
  title: "Fix auth bug",
  started_at: "2026-06-12T10:00:00.000Z",
  finished_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({ workspaceId: WS, apiKeyId: KEY, teamId: TEAM } as never);
  vi.mocked(getRepository).mockResolvedValue({ id: REPO, workspaceId: WS } as never);
  vi.mocked(upsertRun).mockResolvedValue(undefined);
});

describe("POST /api/v1/ingest/runs", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + ok:true and upsertRun called with correct args on valid body", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(upsertRun).toHaveBeenCalledWith({
      id: RUN_ID,
      workspaceId: WS,
      repositoryId: REPO,
      agent: "claude-code",
      branch: "main",
      title: "Fix auth bug",
      status: "running",
      startedAt: "2026-06-12T10:00:00.000Z",
      finishedAt: null,
    });
  });

  it("404 when repo not in workspace (upsertRun NOT called)", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(upsertRun).not.toHaveBeenCalled();
  });

  it("400 on malformed body (missing status)", async () => {
    const { status: _omit, ...noStatus } = valid;
    const res = await POST(req(noStatus));
    expect(res.status).toBe(400);
  });
});
