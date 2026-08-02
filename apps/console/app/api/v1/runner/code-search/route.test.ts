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

// Central-secret auth — same idiom as runner/issue/route.test.ts and
// runner/repo-file/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function getReq(qs: Record<string, string>, withAuth = true): NextRequest {
  const params = new URLSearchParams(qs);
  return new NextRequest(`http://localhost/api/v1/runner/code-search?${params.toString()}`, {
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

function codeSearchResponse(overrides: Record<string, unknown> = {}) {
  return githubJsonResponse(200, {
    total_count: 1,
    items: [
      {
        path: "apps/console/app/api/v1/runner/issue/route.ts",
        text_matches: [{ fragment: "resolveWorkspaceRepoToken(eveSessionId, repo)" }],
      },
    ],
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

describe("GET /api/v1/runner/code-search", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/db/GitHub", async () => {
    const fetchMock = mockFetchOnce();

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "resolveWorkspaceRepoToken" }, false)
    );

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "resolveWorkspaceRepoToken" })
    );
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/runner/code-search?eveSessionId=eve-session-1&repo=ada%2Fwidgets&q=x",
        { headers: { Authorization: "Bearer wrong-secret" } }
      )
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // cheap validation (400) — before any DB or network call
  // ---------------------------------------------------------------------

  it("400 when eveSessionId is missing", async () => {
    const res = await GET(getReq({ repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eveSessionId is required" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when repo is missing or not owner/name", async () => {
    let res = await GET(getReq({ eveSessionId: "eve-session-1", q: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo is required" });

    res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "not-a-repo", q: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be in the form owner/name" });

    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when q is missing, blank, or over 256 chars", async () => {
    const over256 = "x".repeat(257);
    for (const q of [undefined, "", "   ", over256]) {
      const qs: Record<string, string> = { eveSessionId: "eve-session-1", repo: "ada/widgets" };
      if (q !== undefined) qs.q = q;
      const res = await GET(getReq(qs));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "q is required (max 256 chars)" });
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // resolution (404 / 409)
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await GET(getReq({ eveSessionId: "unknown", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("resolves a workspace-anchored, identity-less session (Arc B review-job worker) without calling getChatIdentityById", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      chatIdentityId: null,
    } as never);
    mockFetchOnce(codeSearchResponse());

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));

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

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation has no workspace yet — create one first",
    });
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("404 when the repo is not connected to this workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "someone/else", q: "x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "someone/else");
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("409 when the workspace has no stored GitHub token", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "GitHub is not connected for this workspace — install the Jace GitHub App first",
    });
  });

  // ---------------------------------------------------------------------
  // the GitHub call itself
  // ---------------------------------------------------------------------

  it("200: returns { totalCount, note, results } with path+fragments from GitHub's text-match payload", async () => {
    mockFetchOnce(codeSearchResponse());
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "resolveWorkspaceRepoToken" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalCount: 1,
      note: "textual matches, not a compiled call graph",
      results: [
        {
          path: "apps/console/app/api/v1/runner/issue/route.ts",
          fragments: ["resolveWorkspaceRepoToken(eveSessionId, repo)"],
        },
      ],
    });
  });

  it("caps a fragment longer than 400 chars at exactly 400", async () => {
    const longFragment = "x".repeat(450);
    mockFetchOnce(
      codeSearchResponse({
        items: [{ path: "src/big.ts", text_matches: [{ fragment: longFragment }] }],
      })
    );
    const json = await (
      await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }))
    ).json();
    expect(json.results[0].fragments[0]).toHaveLength(400);
    expect(json.results[0].fragments[0]).toBe(longFragment.slice(0, 400));
  });

  it("drops empty/non-string fragments and coerces a non-string path to \"\"", async () => {
    mockFetchOnce(
      codeSearchResponse({
        items: [
          {
            path: null,
            text_matches: [{ fragment: "" }, { fragment: null }, { fragment: "kept" }],
          },
        ],
      })
    );
    const json = await (
      await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }))
    ).json();
    expect(json.results[0]).toEqual({ path: "", fragments: ["kept"] });
  });

  it("slices results to 20 when GitHub returns more than 20 items", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      path: `file-${i}.ts`,
      text_matches: [{ fragment: `match ${i}` }],
    }));
    mockFetchOnce(codeSearchResponse({ total_count: 25, items }));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "match" }));
    const json = await res.json();
    expect(json.results).toHaveLength(20);
    expect(json.totalCount).toBe(25);
    expect(json.results[0]).toEqual({ path: "file-0.ts", fragments: ["match 0"] });
    expect(json.results[19]).toEqual({ path: "file-19.ts", fragments: ["match 19"] });
  });

  it("defaults totalCount to results.length when GitHub omits total_count", async () => {
    mockFetchOnce(codeSearchResponse({ total_count: undefined }));
    const json = await (
      await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "resolveWorkspaceRepoToken" })
      )
    ).json();
    expect(json.totalCount).toBe(1);
  });

  it("scopes the query to the repo via a repo: qualifier in the GitHub search URL", async () => {
    const fetchMock = mockFetchOnce(codeSearchResponse());
    await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "resolveWorkspaceRepoToken" })
    );
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("repo%3Aada%2Fwidgets");
  });

  it("requests GitHub's text-match media type via the Accept header", async () => {
    const fetchMock = mockFetchOnce(codeSearchResponse());
    await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "resolveWorkspaceRepoToken" })
    );
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Accept).toBe(
      "application/vnd.github.text-match+json"
    );
  });

  it("400 'invalid search query' when GitHub 422s (unparseable query)", async () => {
    mockFetchOnce(
      githubJsonResponse(422, {
        message: "Validation Failed",
        errors: [{ message: "The search is invalid" }],
      })
    );
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "bad(((query" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid search query" });
  });

  it("404 'repo not found on GitHub' when GitHub 404s", async () => {
    mockFetchOnce(githubJsonResponse(404, { message: "Not Found" }));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not found on GitHub" });
  });

  it("429 on 429, and on a 403 whose message names a (secondary) rate limit", async () => {
    mockFetchOnce(githubJsonResponse(429, { message: "rate limit exceeded" }));
    let res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(429);

    mockFetchOnce(githubJsonResponse(403, { message: "API rate limit exceeded for user" }));
    res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "GitHub rate limit exceeded — try again later" });

    // "secondary rate" without the substring "rate limit" — proves the
    // widened regex's second alternative actually fires, not just the first.
    mockFetchOnce(githubJsonResponse(403, { message: "secondary rate cap exceeded, please slow down" }));
    res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "GitHub rate limit exceeded — try again later" });
  });

  it("409 reconnect-GitHub on 401/403 (non-rate-limit)", async () => {
    for (const status of [401, 403]) {
      mockFetchOnce(githubJsonResponse(status, { message: "Bad credentials" }));
      const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "GitHub rejected the workspace's App installation credentials — reconnect GitHub from the console",
      });
    }
  });

  it("502 on an unmapped GitHub status (e.g. 500)", async () => {
    mockFetchOnce(githubJsonResponse(500, { message: "Internal error" }));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(502);
  });

  it("502 when GitHub cannot be reached (network error)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
    expect(res.status).toBe(502);
  });

  it("never leaks the bearer token into any error response", async () => {
    for (const status of [401, 403, 404, 422, 429, 500]) {
      mockFetchOnce(githubJsonResponse(status, { message: "some upstream message" }));
      const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", q: "x" }));
      const text = await res.text();
      expect(text).not.toContain(MOCK_TOKEN);
    }
  });
});
