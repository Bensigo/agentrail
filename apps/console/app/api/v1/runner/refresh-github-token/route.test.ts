import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getInstallationToken: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { getInstallationToken, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const mockGetInstallationToken = vi.mocked(getInstallationToken);
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
  mockGetInstallationToken.mockResolvedValue("ghs_fresh");
});

describe("POST /api/v1/runner/refresh-github-token", () => {
  it("401 when requireBearer rejects — same machine-token auth as claim/result", async () => {
    mockRequireBearer.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await POST(req({ workspace_id: WS }));

    expect(res.status).toBe(401);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it("400 when workspace_id is missing", async () => {
    const res = await POST(req({}));

    expect(res.status).toBe(400);
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it("403 when the bearer's workspace differs from the requested workspace_id", async () => {
    const res = await POST(req({ workspace_id: "some-other-ws" }));

    expect(res.status).toBe(403);
    expect(mockTouch).not.toHaveBeenCalled();
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
  });

  it("200 with a freshly minted installation token, resolved from the bearer's workspace", async () => {
    mockGetInstallationToken.mockResolvedValue("ghs_fresh");

    const res = await POST(req({ workspace_id: WS }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ github_token: "ghs_fresh" });
    // Workspace comes from the bearer, never the request body.
    expect(mockGetInstallationToken).toHaveBeenCalledWith(WS);
    expect(mockTouch).toHaveBeenCalledWith("key-1");
  });

  it("502 refresh_failed when there is no GitHub App installation bound to this workspace", async () => {
    mockGetInstallationToken.mockResolvedValue(null);

    const res = await POST(req({ workspace_id: WS }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "refresh_failed" });
  });

  it("502 refresh_failed never leaks a token when the mint fails", async () => {
    mockGetInstallationToken.mockResolvedValue(null);

    const res = await POST(req({ workspace_id: WS }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(JSON.stringify(body)).not.toContain("ghs_");
  });
});
