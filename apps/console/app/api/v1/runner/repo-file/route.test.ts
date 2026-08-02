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

// Central-secret auth — same idiom as runner/issue/route.test.ts.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function getReq(qs: Record<string, string>, withAuth = true): NextRequest {
  const params = new URLSearchParams(qs);
  return new NextRequest(`http://localhost/api/v1/runner/repo-file?${params.toString()}`, {
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

function fileResponse(overrides: Record<string, unknown> = {}) {
  return githubJsonResponse(200, {
    type: "file",
    name: "index.ts",
    path: "src/index.ts",
    size: 11,
    encoding: "base64",
    content: Buffer.from("hello world").toString("base64"),
    ...overrides,
  });
}

function dirResponse(entries: Array<Record<string, unknown>>) {
  return githubJsonResponse(200, entries);
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

describe("GET /api/v1/runner/repo-file", () => {
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
        "http://localhost/api/v1/runner/repo-file?eveSessionId=eve-session-1&repo=ada%2Fwidgets&path=src%2Findex.ts",
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
    mockFetchOnce(fileResponse());

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
  // the GitHub call itself
  // ---------------------------------------------------------------------

  it("200: file happy path returns the exact { path, ref, kind, content, size, truncated } shape", async () => {
    mockFetchOnce(fileResponse());
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/index.ts" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "src/index.ts",
      ref: "",
      kind: "file",
      content: "hello world",
      size: 11,
      truncated: false,
    });
  });

  it("200: dir happy path maps entries and slices to 100", async () => {
    const entries = Array.from({ length: 105 }, (_, i) => ({
      name: `file-${i}.ts`,
      type: "file",
    }));
    mockFetchOnce(dirResponse(entries));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.kind).toBe("dir");
    expect(json.path).toBe("src");
    expect(json.ref).toBe("");
    expect(json.entries).toHaveLength(100);
    expect(json.entries[0]).toEqual({ name: "file-0.ts", type: "file" });
    expect(json.entries[99]).toEqual({ name: "file-99.ts", type: "file" });
  });

  it("caps file content at 65536 bytes on a UTF-8 boundary and flags truncated", async () => {
    mockFetchOnce(
      fileResponse({ content: Buffer.from("€".repeat(21846)).toString("base64"), size: 65538 })
    );
    const json = await (
      await GET(
        getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/big.ts" })
      )
    ).json();
    expect(json.truncated).toBe(true);
    expect(Buffer.byteLength(json.content, "utf8")).toBeLessThanOrEqual(65536);
    expect(json.content.endsWith("€")).toBe(true);
    expect(json.content.includes("�")).toBe(false);
  });

  it("forwards ref as a GitHub contents API query param", async () => {
    const fetchMock = mockFetchOnce(fileResponse());
    await GET(
      getReq({
        eveSessionId: "eve-session-1",
        repo: "ada/widgets",
        path: "src/index.ts",
        ref: "abc123",
      })
    );
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("?ref=abc123");
  });

  it("encodes each path segment while preserving / separators", async () => {
    const fetchMock = mockFetchOnce(fileResponse());
    await GET(getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "a b/c#d.ts" }));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("a%20b/c%23d.ts");
  });

  it("422 'file too large to fetch' when GitHub 403s with a too-large-blob message", async () => {
    mockFetchOnce(
      githubJsonResponse(403, {
        message:
          "This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the Contents API.",
      })
    );
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "assets/huge.bin" })
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "file too large to fetch" });
  });

  it("422 'path is not a readable file or directory' for a symlink/submodule type", async () => {
    mockFetchOnce(githubJsonResponse(200, { type: "symlink", target: "../elsewhere" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "link" })
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "path is not a readable file or directory" });
  });

  it("404 'File or directory not found' when GitHub 404s", async () => {
    mockFetchOnce(githubJsonResponse(404, { message: "Not Found" }));
    const res = await GET(
      getReq({ eveSessionId: "eve-session-1", repo: "ada/widgets", path: "src/missing.ts" })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File or directory not found" });
  });

  it("409 reconnect-GitHub on 401/403 (non-rate-limit, non-too-large)", async () => {
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
