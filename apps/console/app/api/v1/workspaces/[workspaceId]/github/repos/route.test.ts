import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getInstallationToken: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getInstallationToken } from "@agentrail/db-postgres";

// ── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = "ws-123";

function makeRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/github/repos${query}`
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

/** A GitHub `GET /installation/repositories` response — WRAPPER object, not
 * a bare array — with an optional x-ratelimit-remaining header for the 403
 * rate-limit branch. */
function ghInstallationResponse(
  status: number,
  repositories: unknown[],
  rateRemaining?: string
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "x-ratelimit-remaining"
          ? (rateRemaining ?? null)
          : null,
    },
    json: async () => ({ total_count: repositories.length, repositories }),
  };
}

const RAW_REPOS = [
  {
    full_name: "bensigo/agentrail",
    private: true,
    default_branch: "main",
    html_url: "https://github.com/bensigo/agentrail",
    // extra fields the wire contract must strip:
    id: 42,
    owner: { login: "bensigo" },
  },
  {
    full_name: "acme/website",
    private: false,
    default_branch: "trunk",
    html_url: "https://github.com/acme/website",
  },
];

const originalFetch = global.fetch;

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET /api/v1/workspaces/:workspaceId/github/repos", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when the user is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 403 when the user has member role (not owner/admin)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "member",
    } as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 400 github_not_connected when the workspace has no installation token, and never calls GitHub", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("github_not_connected");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns repos mapped to the snake_case wire contract on success", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "admin",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, RAW_REPOS)) as unknown as typeof fetch;

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.repos).toHaveLength(2);
    expect(json.repos[0]).toEqual({
      full_name: "bensigo/agentrail",
      private: true,
      default_branch: "main",
      html_url: "https://github.com/bensigo/agentrail",
    });
    // no token, no extra github fields leaked
    expect(JSON.stringify(json)).not.toContain("installation-token");
    expect(json.repos[0].id).toBeUndefined();
  });

  it("calls GitHub's installation-repositories endpoint with the installation token, not /user/repos", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, RAW_REPOS));
    global.fetch = fetchMock as unknown as typeof fetch;

    await GET(makeRequest(), makeParams());

    expect(getInstallationToken).toHaveBeenCalledWith(WORKSPACE_ID);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://api.github.com/installation/repositories");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer installation-token",
    });
  });

  it("filters by the q query param (client-side substring over full_name)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, RAW_REPOS)) as unknown as typeof fetch;

    const res = await GET(makeRequest("?q=acme"), makeParams());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.repos).toHaveLength(1);
    expect(json.repos[0].full_name).toBe("acme/website");
  });

  it("returns 401 github_reconnect when GitHub rejects the installation token", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(401, [])) as unknown as typeof fetch;

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.code).toBe("github_reconnect");
  });

  it("returns 429 github_rate_limited on a GitHub 403 rate-limit", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(403, [], "0")) as unknown as typeof fetch;

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.code).toBe("github_rate_limited");
  });

  it("returns 502 github_error when GitHub is unreachable", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue({
      role: "owner",
    } as never);
    vi.mocked(getInstallationToken).mockResolvedValue("installation-token");
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;

    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.code).toBe("github_error");
  });
});
