import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  ensureFreshGithubToken: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { ensureFreshGithubToken, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const mockEnsureFresh = vi.mocked(ensureFreshGithubToken);
const mockTouch = vi.mocked(touchApiKeyLastUsed);
const mockRequireBearer = vi.mocked(requireBearer);

const WS = "ws-1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/refresh-github-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function authResult(kind: "self_hosted" | "fleet" = "fleet") {
  return { apiKeyId: "key-1", workspaceId: WS, teamId: null, kind };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireBearer.mockResolvedValue(authResult() as never);
  mockTouch.mockResolvedValue(undefined as never);
  mockEnsureFresh.mockResolvedValue({ accessToken: "ghu_fresh", outcome: "refreshed" });
});

describe("POST /api/v1/runner/refresh-github-token", () => {
  it("401 when requireBearer rejects — same machine-token auth as claim/result", async () => {
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await POST(req({ workspace_id: WS }));

    expect(res.status).toBe(401);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  it("400 when workspace_id is missing", async () => {
    const res = await POST(req({}));

    expect(res.status).toBe(400);
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  it("403 when the bearer's workspace differs from the requested workspace_id", async () => {
    const res = await POST(req({ workspace_id: "some-other-ws" }));

    expect(res.status).toBe(403);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  it("200 with the fresh github_token on a successful refresh, forcing a refresh", async () => {
    const res = await POST(req({ workspace_id: WS }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ github_token: "ghu_fresh" });
    // Forces a refresh — the caller only reaches here after a push already 401'd.
    expect(mockEnsureFresh).toHaveBeenCalledWith(WS, { force: true });
    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });

  it("200 with the token when the stored one was still usable (no-op outcome)", async () => {
    mockEnsureFresh.mockResolvedValue({ accessToken: "ghu_stored", outcome: "no-op" });

    const res = await POST(req({ workspace_id: WS }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ github_token: "ghu_stored" });
  });

  it("502 refresh_failed when the refresh is unrecoverable (bad_refresh_token / network)", async () => {
    mockEnsureFresh.mockResolvedValue({ accessToken: "ghu_stale", outcome: "refresh-failed" });

    const res = await POST(req({ workspace_id: WS }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "refresh_failed" });
    // The token is NEVER returned on a failure — only the distinct signal.
    expect(JSON.stringify(body)).not.toContain("ghu_stale");
  });

  it("502 refresh_failed when the workspace has no linked GitHub owner", async () => {
    mockEnsureFresh.mockResolvedValue({ accessToken: null, outcome: "no-account" });

    const res = await POST(req({ workspace_id: WS }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "refresh_failed" });
  });
});
