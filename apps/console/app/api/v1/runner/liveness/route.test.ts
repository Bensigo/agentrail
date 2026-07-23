import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Closed factory: only the two query fns this route touches. Auth is mocked as
// its own module below so we can drive the 401/403/happy branches directly.
vi.mock("@agentrail/db-postgres", () => ({
  recordRunnerLiveness: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { recordRunnerLiveness, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER_WS = "00000000-0000-0000-0000-000000000002";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/liveness", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
    kind: "fleet",
  } as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
  vi.mocked(recordRunnerLiveness).mockResolvedValue({ updated: true });
});

describe("POST /api/v1/runner/liveness — auth", () => {
  it("returns the 401 requireBearer hands back when the token is rejected", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await POST(req({ id: "qe-1", workspace_id: WS }, false));
    expect(res.status).toBe(401);
    // Never touches the DB when auth fails.
    expect(recordRunnerLiveness).not.toHaveBeenCalled();
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("403s when the token's workspace differs from the body workspace_id", async () => {
    const res = await POST(req({ id: "qe-1", workspace_id: OTHER_WS }));
    expect(res.status).toBe(403);
    expect(recordRunnerLiveness).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/runner/liveness — validation", () => {
  it("400s when id is missing", async () => {
    const res = await POST(req({ workspace_id: WS }));
    expect(res.status).toBe(400);
    expect(recordRunnerLiveness).not.toHaveBeenCalled();
  });

  it("400s when workspace_id is missing", async () => {
    const res = await POST(req({ id: "qe-1" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/runner/liveness — happy path", () => {
  it("stamps liveness and returns 202 on a running run", async () => {
    const res = await POST(req({ id: "qe-1", workspace_id: WS }));
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(touchApiKeyLastUsed).toHaveBeenCalledWith(KEY);
    expect(recordRunnerLiveness).toHaveBeenCalledWith({
      id: "qe-1",
      workspaceId: WS,
    });
  });

  it("404s when no running run exists for that id (already terminal / unknown)", async () => {
    vi.mocked(recordRunnerLiveness).mockResolvedValue({ updated: false });
    const res = await POST(req({ id: "qe-gone", workspace_id: WS }));
    expect(res.status).toBe(404);
  });
});
