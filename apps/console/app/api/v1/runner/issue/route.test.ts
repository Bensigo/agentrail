import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getInstallationToken: vi.fn(),
  getRepositoryByName: vi.fn(),
}));
import { GET } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";

const NOW = new Date("2026-07-23T00:00:00.000Z");
const MOCK_TOKEN = "ghs_mock_token_abc123";

// Central-secret auth — same idiom as runner/repos/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function getReq(qs: Record<string, string>, withAuth = true): NextRequest {
  const params = new URLSearchParams(qs);
  return new NextRequest(`http://localhost/api/v1/runner/issue?${params.toString()}`, {
    method: "GET",
    headers: withAuth ? { Authorization: `Bearer ${SECRET}` } : {},
  });
}

const PINNED_SESSION = {
  id: "session-1",
  workspaceId: "ws-1",
  chatIdentityId: "chat-identity-1",
  channel: "telegram",
  conversationKey: "tg-chat-42",
  eveSessionId: "eve-session-1",
  status: "active",
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const BOUND_IDENTITY = {
  id: "chat-identity-1",
  platform: "telegram",
  platformUserId: "tg-123",
  displayName: "Ada",
  userId: "user-1",
  workspaceId: "ws-1",
  linkToken: null,
  linkTokenExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CONNECTED_REPO = {
  id: "repo-1",
  workspaceId: "ws-1",
  name: "ada/widgets",
  url: "https://github.com/ada/widgets",
  defaultBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
};

function githubJsonResponse(status: number, body: unknown): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function issueResponse(overrides: Record<string, unknown> = {}) {
  return githubJsonResponse(200, {
    number: 42,
    title: "Widgets must persist",
    body: "## Acceptance criteria\n- [ ] AC1: widgets persist across restarts",
    state: "open",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(PINNED_SESSION as never);
  vi.mocked(getChatIdentityById).mockResolvedValue(BOUND_IDENTITY as never);
  vi.mocked(getInstallationToken).mockResolvedValue(MOCK_TOKEN);
  vi.mocked(getRepositoryByName).mockResolvedValue(CONNECTED_REPO as never);
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

function mockFetchOnce(...responses: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("GET /api/v1/runner/issue", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/db/GitHub", async () => {
    const fetchMock = mockFetchOnce();

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" }, false)
    );

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/runner/issue?eveSessionId=eve-session-1&repo=ada%2Fwidgets&issueNumber=98",
        { headers: { Authorization: "Bearer wrong-secret" } }
      )
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // cheap validation (400) — before any DB or network call
  // ---------------------------------------------------------------------

  it("400 when eveSessionId is missing", async () => {
    const res = await GET(getReq({ repo: "ada/widgets", issueNumber: "98" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eveSessionId is required" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when repo is missing or not owner/name", async () => {
    let res = await GET(getReq({ eveSessionId: "eve-session-1", issueNumber: "98" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo is required" });

    res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "not-a-repo", issueNumber: "98" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be in the form owner/name" });

    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when issueNumber is missing, zero, negative, or non-numeric", async () => {
    for (const issueNumber of ["", "0", "-1", "abc", "1.5"]) {
      const res = await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "issueNumber must be a positive integer" });
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // resolution (404 / 409)
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await GET(
      getReq({ eveSessionId: "unknown", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat identity not found" });
  });

  it("409 when neither the session nor the identity has a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({
      ...BOUND_IDENTITY,
      workspaceId: null,
    } as never);

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation has no workspace yet — create one first",
    });
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("404 when the repo is not connected to this workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "someone/else", issueNumber: "98" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "someone/else");
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("409 when the workspace has no stored GitHub token", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "GitHub is not connected for this workspace — install the Jace GitHub App first",
    });
  });

  // ---------------------------------------------------------------------
  // the GitHub call itself
  // ---------------------------------------------------------------------

  it("200: returns number/title/body/state/bodyTruncated", async () => {
    mockFetchOnce(issueResponse());
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "42" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      number: 42,
      title: "Widgets must persist",
      body: "## Acceptance criteria\n- [ ] AC1: widgets persist across restarts",
      state: "open",
      bodyTruncated: false,
    });
  });

  it("404 'that number is a pull request, not an issue' when the payload carries a pull_request key", async () => {
    mockFetchOnce(
      issueResponse({ pull_request: { url: "https://api.github.com/repos/ada/widgets/pulls/42" } })
    );
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "42" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "that number is a pull request, not an issue" });
  });

  it("caps the body at 8000 bytes on a UTF-8 boundary and flags bodyTruncated", async () => {
    mockFetchOnce(issueResponse({ body: "€".repeat(2667) })); // 3 bytes each = 8001 bytes
    const json = await (
      await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "42" }))
    ).json();
    expect(json.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(json.body, "utf8")).toBeLessThanOrEqual(8000);
    expect(json.body.endsWith("€")).toBe(true);
    expect(json.body.includes("�")).toBe(false);
  });

  it("null/non-string GitHub fields coerce to safe defaults", async () => {
    mockFetchOnce(issueResponse({ title: null, body: null, state: undefined }));
    const json = await (
      await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "42" }))
    ).json();
    expect(json.title).toBe("");
    expect(json.body).toBe("");
    expect(json.state).toBe("");
  });

  it("404 'Issue not found' when GitHub 404s", async () => {
    mockFetchOnce(githubJsonResponse(404, { message: "Not Found" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Issue not found" });
  });

  it("409 reconnect-GitHub on 401/403 (non-rate-limit)", async () => {
    for (const status of [401, 403]) {
      mockFetchOnce(githubJsonResponse(status, { message: "Bad credentials" }));
      const res = await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "GitHub rejected the workspace's App installation credentials — reconnect GitHub from the console",
      });
    }
  });

  it("429 on 429, and on a 403 whose message names a rate limit", async () => {
    mockFetchOnce(githubJsonResponse(429, { message: "rate limit exceeded" }));
    let res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(429);

    mockFetchOnce(githubJsonResponse(403, { message: "API rate limit exceeded for user" }));
    res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "GitHub rate limit exceeded — try again later" });
  });

  it("502 on an unmapped GitHub status (e.g. 500)", async () => {
    mockFetchOnce(githubJsonResponse(500, { message: "Internal error" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(502);
  });

  it("502 when GitHub cannot be reached (network error)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
    );
    expect(res.status).toBe(502);
  });

  it("never leaks the bearer token into any error response", async () => {
    for (const status of [404, 401, 403, 429, 500]) {
      mockFetchOnce(githubJsonResponse(status, { message: "some upstream message" }));
      const res = await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", issueNumber: "98" })
      );
      const text = await res.text();
      expect(text).not.toContain(MOCK_TOKEN);
    }
  });
});
