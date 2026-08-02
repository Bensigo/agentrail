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

// Central-secret auth — same idiom as runner/issue/route.test.ts,
// runner/repo-file/route.test.ts, and runner/code-search/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function getReq(qs: Record<string, string>, withAuth = true): NextRequest {
  const params = new URLSearchParams(qs);
  return new NextRequest(`http://localhost/api/v1/runner/file-history?${params.toString()}`, {
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

function commitItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: "abc1234def5678900000000000000000000000",
    author: { login: "ada-gh" },
    commit: {
      author: { name: "Ada Lovelace", date: "2026-07-20T10:00:00.000Z" },
      message: "Fix the thing\n\nLonger explanation body.",
    },
    ...overrides,
  };
}

function commitsResponse(items: Array<Record<string, unknown>>) {
  return githubJsonResponse(200, items);
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

describe("GET /api/v1/runner/file-history", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/db/GitHub", async () => {
    const fetchMock = mockFetchOnce();

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" }, false)
    );

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/runner/file-history?eveSessionId=eve-session-1&repo=ada%2Fwidgets&path=src%2Findex.ts",
        { headers: { Authorization: "Bearer wrong-secret" } }
      )
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // cheap validation (400) — before any DB or network call
  // ---------------------------------------------------------------------

  it("400 when eveSessionId is missing", async () => {
    const res = await GET(getReq({ repo: "ada/widgets", path: "src/index.ts" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eveSessionId is required" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when repo is missing or not owner/name", async () => {
    let res = await GET(getReq({ eveSessionId: "eve-session-1", path: "src/index.ts" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo is required" });

    res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "not-a-repo", path: "src/index.ts" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be in the form owner/name" });

    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when path is missing or blank", async () => {
    for (const path of [undefined, "", "   "]) {
      const qs: Record<string, string> = { eveSessionId: "eve-session-1", repo: "ada/widgets" };
      if (path !== undefined) qs.path = path;
      const res = await GET(getReq(qs));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "path is required" });
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when path is absolute or contains . or .. segments", async () => {
    for (const path of ["/etc/passwd", "..", "../secret", "a/../b", ".", "a/./b", "a/../../b"]) {
      const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "path must be a relative path without . or .. segments",
      });
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // resolution (404 / 409)
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await GET(
      getReq({ eveSessionId: "unknown", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("resolves a workspace-anchored, identity-less session (Arc B review-job worker) without calling getChatIdentityById", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      chatIdentityId: null,
    } as never);
    mockFetchOnce(commitsResponse([commitItem()]));

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );

    expect(res.status).toBe(200);
    expect(getChatIdentityById).not.toHaveBeenCalled();
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
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
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
      getReq({ eveSessionId: "eve-session-1", repo: "someone/else", path: "src/index.ts" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "someone/else");
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("409 when the workspace has no stored GitHub token", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "GitHub is not connected for this workspace — install the Jace GitHub App first",
    });
  });

  // ---------------------------------------------------------------------
  // limit: default / NaN / clamp — asserted against the fetch URL's per_page
  // ---------------------------------------------------------------------

  it("defaults per_page to 10 when limit is missing", async () => {
    const fetchMock = mockFetchOnce(commitsResponse([]));
    await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" }));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("per_page=10");
  });

  it("defaults per_page to 10 when limit is not a number or is less than 1", async () => {
    for (const limit of ["abc", "0", "-5", ""]) {
      const fetchMock = mockFetchOnce(commitsResponse([]));
      await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts", limit })
      );
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("per_page=10");
    }
  });

  it("clamps per_page to 20 when limit is over 20", async () => {
    const fetchMock = mockFetchOnce(commitsResponse([]));
    await GET(
      getReq({
        eveSessionId: "eve-session-1",
        repo: "ada/widgets",
        path: "src/index.ts",
        limit: "500",
      })
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("per_page=20");
  });

  it("passes a valid limit through unchanged", async () => {
    const fetchMock = mockFetchOnce(commitsResponse([]));
    await GET(
      getReq({
        eveSessionId: "eve-session-1",
        repo: "ada/widgets",
        path: "src/index.ts",
        limit: "15",
      })
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("per_page=15");
  });

  // ---------------------------------------------------------------------
  // the GitHub call itself
  // ---------------------------------------------------------------------

  it("200: happy path returns the exact { path, commits } shape", async () => {
    mockFetchOnce(commitsResponse([commitItem()]));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "src/index.ts",
      commits: [
        {
          sha: "abc1234def5678900000000000000000000000",
          shortSha: "abc1234",
          authorLogin: "ada-gh",
          date: "2026-07-20T10:00:00.000Z",
          messageFirstLine: "Fix the thing",
        },
      ],
    });
  });

  it("falls back authorLogin to commit.author.name when the top-level author is null", async () => {
    mockFetchOnce(commitsResponse([commitItem({ author: null })]));
    const json = await (
      await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
      )
    ).json();
    expect(json.commits[0].authorLogin).toBe("Ada Lovelace");
  });

  it("caps messageFirstLine to the first line, then to 200 chars (multi-line, 250-char first line fixture)", async () => {
    const firstLine = "x".repeat(250);
    mockFetchOnce(
      commitsResponse([
        commitItem({
          commit: {
            author: { name: "Ada Lovelace", date: "2026-07-20T10:00:00.000Z" },
            message: `${firstLine}\nsecond line\nthird line`,
          },
        }),
      ])
    );
    const json = await (
      await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
      )
    ).json();
    expect(json.commits[0].messageFirstLine).toHaveLength(200);
    expect(json.commits[0].messageFirstLine).toBe(firstLine.slice(0, 200));
    expect(json.commits[0].messageFirstLine).not.toContain("\n");
  });

  it("slices commits to the effective limit", async () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      commitItem({ sha: `sha-${i}-000000000000000000000000000000000` })
    );
    mockFetchOnce(commitsResponse(items));
    const res = await GET(
      getReq({
        eveSessionId: "eve-session-1",
        repo: "ada/widgets",
        path: "src/index.ts",
        limit: "5",
      })
    );
    const json = await res.json();
    expect(json.commits).toHaveLength(5);
    expect(json.commits[0].sha).toBe("sha-0-000000000000000000000000000000000");
    expect(json.commits[4].sha).toBe("sha-4-000000000000000000000000000000000");
  });

  it("calls the GitHub commits endpoint scoped to repo and path", async () => {
    const fetchMock = mockFetchOnce(commitsResponse([]));
    await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(
      "https://api.github.com/repos/ada/widgets/commits?path=src%2Findex.ts&per_page=10"
    );
  });

  it("encodes the path as a single query-string value, including internal slashes and spaces", async () => {
    const fetchMock = mockFetchOnce(commitsResponse([]));
    await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/a b.ts" }));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("path=src%2Fa%20b.ts");
  });

  it("502 'GitHub returned an unexpected response.' when the success body is not an array", async () => {
    mockFetchOnce(githubJsonResponse(200, { message: "not an array" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "GitHub returned an unexpected response." });
  });

  it("404 when GitHub 404s", async () => {
    mockFetchOnce(githubJsonResponse(404, { message: "Not Found" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(404);
  });

  it("409 reconnect-GitHub on 401/403 (non-rate-limit)", async () => {
    for (const status of [401, 403]) {
      mockFetchOnce(githubJsonResponse(status, { message: "Bad credentials" }));
      const res = await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
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
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(429);

    mockFetchOnce(githubJsonResponse(403, { message: "API rate limit exceeded for user" }));
    res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "GitHub rate limit exceeded — try again later" });
  });

  it("502 on an unmapped GitHub status (e.g. 500)", async () => {
    mockFetchOnce(githubJsonResponse(500, { message: "Internal error" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(502);
  });

  it("502 when GitHub cannot be reached (network error)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(502);
  });

  it("never leaks the bearer token into any error response", async () => {
    for (const status of [404, 401, 403, 429, 500]) {
      mockFetchOnce(githubJsonResponse(status, { message: "some upstream message" }));
      const res = await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
      );
      const text = await res.text();
      expect(text).not.toContain(MOCK_TOKEN);
    }
  });
});
