import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getInstallationToken: vi.fn(),
  getRepositoryByName: vi.fn(),
}));
import { GET, POST } from "./route";
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
  return new NextRequest(`http://localhost/api/v1/runner/pr-review?${params.toString()}`, {
    method: "GET",
    headers: withAuth ? { Authorization: `Bearer ${SECRET}` } : {},
  });
}

function postReq(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/pr-review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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

function prMetaResponse(overrides: Record<string, unknown> = {}) {
  return githubJsonResponse(200, {
    title: "Add widgets",
    body: "This adds widgets.",
    user: { login: "ada" },
    base: { ref: "main" },
    head: { ref: "ada/widgets-branch" },
    ...overrides,
  });
}

function filesPage(files: unknown[], status = 200) {
  return githubJsonResponse(status, files);
}

function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    filename: "src/index.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: "@@ -1,3 +1,3 @@\n-old\n+new",
    ...overrides,
  };
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

function mockFetchSequence(...responses: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("GET /api/v1/runner/pr-review", () => {
  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/db/GitHub", async () => {
    const fetchMock = mockFetchSequence();

    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }, false)
    );

    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
    delete process.env[ENV_KEY];
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("401 on a wrong secret", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/v1/runner/pr-review?eveSessionId=eve-session-1&repo=ada%2Fwidgets&prNumber=98",
        { headers: { Authorization: "Bearer wrong-secret" } }
      )
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // cheap validation (400) — before any DB or network call
  // ---------------------------------------------------------------------

  it("400 when eveSessionId is missing", async () => {
    const res = await GET(getReq({ repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when repo is missing", async () => {
    const res = await GET(getReq({ eveSessionId: "eve-session-1", prNumber: "98" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo is required" });
  });

  it("400 when repo is not in owner/name form", async () => {
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "not-a-repo", prNumber: "98" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be in the form owner/name" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when prNumber is missing, zero, negative, or non-numeric", async () => {
    for (const prNumber of ["", "0", "-1", "abc", "1.5"]) {
      const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber }));
      expect(res.status).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // resolution (404 / 409) — shared with POST
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await GET(getReq({ eveSessionId: "unknown", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat identity not found" });
  });

  it("409 when neither the session nor the identity has a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "this conversation has no workspace yet — create one first",
    });
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("404 when the repo is not connected to this workspace — never proxies an arbitrary repo", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "someone/else", prNumber: "98" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
    expect(getRepositoryByName).toHaveBeenCalledWith("ws-1", "someone/else");
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("409 when the workspace has no stored GitHub token", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "GitHub is not connected for this workspace — install the Jace GitHub App first",
    });
  });

  // ---------------------------------------------------------------------
  // the GitHub calls themselves
  // ---------------------------------------------------------------------

  it("calls GitHub PR metadata with the exact URL and bearer (the mocked token, not a literal)", async () => {
    const fetchMock = mockFetchSequence(prMetaResponse(), filesPage([]));

    await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/ada/widgets/pulls/98",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${MOCK_TOKEN}` }),
      })
    );
  });

  it("200: returns title/author/baseRef/headRef/body/changedFiles/truncated/omittedPaths", async () => {
    mockFetchSequence(prMetaResponse(), filesPage([fileEntry()]));

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      title: "Add widgets",
      author: "ada",
      baseRef: "main",
      headRef: "ada/widgets-branch",
      body: "This adds widgets.",
      changedFiles: [
        {
          path: "src/index.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,3 +1,3 @@\n-old\n+new",
        },
      ],
      truncated: false,
      omittedPaths: [],
    });
  });

  it("paginates the files endpoint until a short page signals the end", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => fileEntry({ filename: `file-${i}.ts` }));
    const fetchMock = mockFetchSequence(prMetaResponse(), filesPage(fullPage), filesPage([fileEntry({ filename: "last.ts" })]));

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    await res.json();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/ada/widgets/pulls/98/files?per_page=100&page=1",
      expect.anything()
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/repos/ada/widgets/pulls/98/files?per_page=100&page=2",
      expect.anything()
    );
  });

  it("caps changedFiles at 50 and lists every omitted path with truncated:true", async () => {
    const files = Array.from({ length: 60 }, (_, i) => fileEntry({ filename: `file-${i}.ts` }));
    mockFetchSequence(prMetaResponse(), filesPage(files));

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    const json = await res.json();

    expect(json.truncated).toBe(true);
    expect(json.changedFiles).toHaveLength(50);
    expect(json.omittedPaths).toHaveLength(10);
    expect(json.omittedPaths[0]).toBe("file-50.ts");
  });

  it("omits a single oversized file's patch (bytes alone exceed the ~200KB cap) while still including smaller files that fit under the running total", async () => {
    const hugePatch = "x".repeat(250_000);
    const files = [fileEntry({ filename: "huge.ts", patch: hugePatch }), fileEntry({ filename: "small.ts" })];
    mockFetchSequence(prMetaResponse(), filesPage(files));

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    const json = await res.json();

    expect(json.truncated).toBe(true);
    expect(json.changedFiles.map((f: { path: string }) => f.path)).toEqual(["small.ts"]);
    expect(json.omittedPaths).toEqual(["huge.ts"]);
  });

  it("the byte cap applies against the running total across files, not just each file in isolation", async () => {
    // Three files at 80KB each: the first two fit (80K, then 160K <= 200K);
    // the third would push the running total to 240K (over cap) and is
    // omitted, even though 80KB alone would never trip the cap.
    const patch80k = "x".repeat(80_000);
    const files = [
      fileEntry({ filename: "first.ts", patch: patch80k }),
      fileEntry({ filename: "second.ts", patch: patch80k }),
      fileEntry({ filename: "third.ts", patch: patch80k }),
    ];
    mockFetchSequence(prMetaResponse(), filesPage(files));

    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    const json = await res.json();

    expect(json.truncated).toBe(true);
    expect(json.changedFiles.map((f: { path: string }) => f.path)).toEqual(["first.ts", "second.ts"]);
    expect(json.omittedPaths).toEqual(["third.ts"]);
  });

  it("404 'PR not found' when GitHub 404s the PR metadata call", async () => {
    mockFetchSequence(githubJsonResponse(404, { message: "Not Found" }));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PR not found" });
  });

  it("409 'GitHub rejected the workspace's App installation credentials' on a 401/403 (non-rate-limit)", async () => {
    for (const status of [401, 403]) {
      mockFetchSequence(githubJsonResponse(status, { message: "Bad credentials" }));
      const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "GitHub rejected the workspace's App installation credentials — reconnect GitHub from the console",
      });
    }
  });

  it("429 on an explicit 429, and on a 403 whose message names a rate limit", async () => {
    mockFetchSequence(githubJsonResponse(429, { message: "rate limit exceeded" }));
    let res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(429);

    mockFetchSequence(githubJsonResponse(403, { message: "API rate limit exceeded for user" }));
    res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "GitHub rate limit exceeded — try again later" });
  });

  it("502 on an unmapped GitHub status (e.g. 500)", async () => {
    mockFetchSequence(githubJsonResponse(500, { message: "Internal error" }));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(502);
  });

  it("502 when GitHub cannot be reached (network error) on the PR metadata call", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(502);
  });

  it("502 when GitHub cannot be reached (network error) mid-pagination on the files call", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(prMetaResponse());
    fetchMock.mockRejectedValueOnce(new Error("connection reset"));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    expect(res.status).toBe(502);
  });

  it("never leaks the bearer token into any error response", async () => {
    mockFetchSequence(githubJsonResponse(500, { message: "Internal error" }));
    const res = await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", prNumber: "98" }));
    const text = await res.text();
    expect(text).not.toContain(MOCK_TOKEN);
  });
});

describe("POST /api/v1/runner/pr-review", () => {
  const VALID_BODY = {
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 98,
    summary: "Looks good overall.",
    comments: [{ path: "src/index.ts", line: 12, body: "Consider a null check here." }],
  };

  function reviewCreatedResponse(overrides: Record<string, unknown> = {}) {
    return githubJsonResponse(200, {
      html_url: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------

  it("401 when no Authorization header is sent, and never touches session/db/GitHub", async () => {
    const fetchMock = mockFetchSequence();
    const res = await POST(postReq(VALID_BODY, false));
    expect(res.status).toBe(401);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset", async () => {
    delete process.env[ENV_KEY];
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // body validation (400)
  // ---------------------------------------------------------------------

  it("400 on invalid JSON", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/v1/runner/pr-review", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: "{not valid json",
      })
    );
    expect(res.status).toBe(400);
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when required fields are missing", async () => {
    for (const bad of [
      { ...VALID_BODY, eveSessionId: "" },
      { ...VALID_BODY, repo: "" },
      { ...VALID_BODY, prNumber: 0 },
      { ...VALID_BODY, prNumber: -1 },
      { ...VALID_BODY, prNumber: 1.5 },
      { ...VALID_BODY, summary: undefined },
      { ...VALID_BODY, comments: "not-an-array" },
    ]) {
      const res = await POST(postReq(bad));
      expect(res.status).toBe(400);
    }
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("400 when a comment entry is malformed (missing path/line/body, or a non-positive line)", async () => {
    for (const comment of [
      { line: 12, body: "x" },
      { path: "a.ts", body: "x" },
      { path: "a.ts", line: 12 },
      { path: "a.ts", line: 0, body: "x" },
      { path: "a.ts", line: -1, body: "x" },
      { path: "", line: 12, body: "x" },
    ]) {
      const res = await POST(postReq({ ...VALID_BODY, comments: [comment] }));
      expect(res.status).toBe(400);
    }
  });

  it("400 when both summary and comments are empty — nothing to post", async () => {
    const res = await POST(postReq({ ...VALID_BODY, summary: "", comments: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "summary or at least one comment is required" });
    expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
  });

  it("accepts an empty summary when at least one comment is present", async () => {
    mockFetchSequence(reviewCreatedResponse());
    const res = await POST(postReq({ ...VALID_BODY, summary: "" }));
    expect(res.status).toBe(201);
  });

  it("400 when repo is not in owner/name form", async () => {
    const res = await POST(postReq({ ...VALID_BODY, repo: "not-a-repo" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo must be in the form owner/name" });
  });

  // ---------------------------------------------------------------------
  // resolution (404 / 409) — same chain as GET
  // ---------------------------------------------------------------------

  it("404 when no jace_sessions row is bound to this eveSessionId", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(404);
  });

  it("409 when neither the session nor the identity has a workspace", async () => {
    vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({
      ...PINNED_SESSION,
      workspaceId: null,
    } as never);
    vi.mocked(getChatIdentityById).mockResolvedValue({ ...BOUND_IDENTITY, workspaceId: null } as never);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it("404 when the repo is not connected to this workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
  });

  it("409 when the workspace has no stored GitHub token", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  // ---------------------------------------------------------------------
  // the GitHub review call — event is HARDCODED to COMMENT
  // ---------------------------------------------------------------------

  it("posts to the reviews endpoint with the bearer, event:COMMENT (never APPROVE/REQUEST_CHANGES), and side:RIGHT inline comments", async () => {
    const fetchMock = mockFetchSequence(reviewCreatedResponse());

    await POST(postReq(VALID_BODY));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/ada/widgets/pulls/98/reviews");
    expect((init as RequestInit).method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${MOCK_TOKEN}`);
    const parsedBody = JSON.parse((init as RequestInit).body as string);
    expect(parsedBody.event).toBe("COMMENT");
    expect(parsedBody.body).toBe("Looks good overall.");
    expect(parsedBody.comments).toEqual([
      { path: "src/index.ts", line: 12, side: "RIGHT", body: "Consider a null check here." },
    ]);
  });

  it("never includes an event value other than COMMENT even if the request body tried to smuggle one (extra keys are ignored)", async () => {
    const fetchMock = mockFetchSequence(reviewCreatedResponse());
    await POST(postReq({ ...VALID_BODY, event: "APPROVE" } as never));
    const parsedBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(parsedBody.event).toBe("COMMENT");
  });

  it("201: returns posted/reviewUrl/summary/inlineCommentsPosted/foldedComments on success", async () => {
    mockFetchSequence(reviewCreatedResponse());
    const res = await POST(postReq(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(json).toEqual({
      posted: true,
      reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
      summary: "Looks good overall.",
      inlineCommentsPosted: 1,
      foldedComments: [],
    });
  });

  // ---------------------------------------------------------------------
  // 422 — retry ONCE with comments folded into the summary
  // ---------------------------------------------------------------------

  it("on a 422 (line not in diff), retries exactly once with comments folded into the summary and an empty comments array", async () => {
    const fetchMock = mockFetchSequence(
      githubJsonResponse(422, { message: "Unprocessable Entity", errors: [{ field: "line" }] }),
      reviewCreatedResponse()
    );

    const res = await POST(postReq(VALID_BODY));
    const json = await res.json();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.comments).toBeUndefined();
    expect(secondBody.body).toContain("Looks good overall.");
    expect(secondBody.body).toContain("src/index.ts:12");
    expect(secondBody.body).toContain("Consider a null check here.");

    expect(res.status).toBe(201);
    expect(json.inlineCommentsPosted).toBe(0);
    expect(json.foldedComments).toEqual(VALID_BODY.comments);
    expect(json.summary).toContain("src/index.ts:12");
  });

  it("422 fold still lands with a sensible summary when the original summary was empty", async () => {
    const fetchMock = mockFetchSequence(
      githubJsonResponse(422, { message: "Unprocessable Entity" }),
      reviewCreatedResponse()
    );

    await POST(postReq({ ...VALID_BODY, summary: "" }));

    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.body).toContain("src/index.ts:12");
    expect(secondBody.body).toContain("Consider a null check here.");
  });

  it("retries only ONCE — a 422 on the retry itself is classified as a normal failure, not retried again", async () => {
    const fetchMock = mockFetchSequence(
      githubJsonResponse(422, { message: "first" }),
      githubJsonResponse(422, { message: "second" })
    );

    const res = await POST(postReq(VALID_BODY));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(502);
  });

  // ---------------------------------------------------------------------
  // other GitHub error classification — same posture as GET
  // ---------------------------------------------------------------------

  it("404 'PR not found' when GitHub 404s the review post", async () => {
    mockFetchSequence(githubJsonResponse(404, { message: "Not Found" }));
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PR not found" });
  });

  it("409 'GitHub rejected the workspace's App installation credentials' on 401/403", async () => {
    for (const status of [401, 403]) {
      mockFetchSequence(githubJsonResponse(status, { message: "Bad credentials" }));
      const res = await POST(postReq(VALID_BODY));
      expect(res.status).toBe(409);
    }
  });

  it("429 on rate limiting", async () => {
    mockFetchSequence(githubJsonResponse(429, {}));
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(429);
  });

  it("502 on an unmapped status and on a network error", async () => {
    mockFetchSequence(githubJsonResponse(500, {}));
    let res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(502);

    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(502);
  });

  it("never leaks the bearer token into any error response", async () => {
    mockFetchSequence(githubJsonResponse(500, { message: "Internal error" }));
    const res = await POST(postReq(VALID_BODY));
    const text = await res.text();
    expect(text).not.toContain(MOCK_TOKEN);
  });
});
