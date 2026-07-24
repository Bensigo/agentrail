import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getInstallationToken: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
}));

import { GET } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getInstallationToken,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";

const WS = "ws-1";
const EVE = "eve-session-1";
const MOCK_TOKEN = "ghs_mock_token";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(opts: { eveSessionId?: string; token?: string } = {}): NextRequest {
  const { eveSessionId, token } = opts;
  const params = new URLSearchParams();
  if (eveSessionId !== undefined) params.set("eveSessionId", eveSessionId);
  const qs = params.toString();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(`http://localhost/api/v1/runner/backlog${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers,
  });
}

function githubJson(status: number, body: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function issueEntry(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "An open issue",
    labels: [{ name: "bug" }],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    comments: 2,
    body: "the body",
    ...overrides,
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({ workspaceId: WS, chatIdentityId: "ci-1" } as never);
  vi.mocked(getChatIdentityById).mockResolvedValue({ id: "ci-1", workspaceId: WS } as never);
  vi.mocked(getInstallationToken).mockResolvedValue(MOCK_TOKEN);
  vi.mocked(listWorkspaceRepositories).mockResolvedValue([{ name: "o/r" }] as never);
});

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

describe("GET /api/v1/runner/backlog", () => {
  describe("auth (central JACE_CONSOLE_TOKEN)", () => {
    it("401 when no Authorization header, never touches db/GitHub", async () => {
      const fetchMock = mockFetchSequence();
      const res = await GET(req({ eveSessionId: EVE }));
      expect(res.status).toBe(401);
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed)", async () => {
      delete process.env[ENV_KEY];
      const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
      expect(res.status).toBe(401);
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await GET(req({ eveSessionId: EVE, token: "wrong" }));
      expect(res.status).toBe(401);
    });
  });

  describe("tenant resolution (eveSessionId -> ledger, never a caller-supplied workspaceId)", () => {
    it("400 when eveSessionId is missing", async () => {
      const res = await GET(req({ token: SECRET }));
      expect(res.status).toBe(400);
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
    });

    it("404 when no session/workspace resolves", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
      vi.mocked(getChatIdentityById).mockResolvedValue(null as never);
      const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
      expect(res.status).toBe(404);
    });

    it("resolves the workspace from the session ledger, never a caller-supplied workspaceId (there is no such param)", async () => {
      mockFetchSequence(githubJson(200, []));
      await GET(req({ eveSessionId: EVE, token: SECRET }));
      expect(getJaceSessionByEveSessionId).toHaveBeenCalledWith(EVE);
      expect(getInstallationToken).toHaveBeenCalledWith(WS);
      expect(listWorkspaceRepositories).toHaveBeenCalledWith(WS);
    });
  });

  it("409 when the workspace has no connected GitHub token", async () => {
    vi.mocked(getInstallationToken).mockResolvedValue(null);
    const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
    expect(res.status).toBe(409);
  });

  it("200: normalizes open issues and drops pull requests", async () => {
    mockFetchSequence(
      githubJson(200, [
        issueEntry({ number: 10, title: "real issue", labels: [{ name: "bug" }, "security"] }),
        issueEntry({ number: 11, title: "a PR", pull_request: { url: "https://api.github.com/pr/11" } }),
      ]),
    );
    const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      repo: "o/r",
      number: 10,
      title: "real issue",
      labels: ["bug", "security"],
      comments: 2,
    });
    expect(body.repos).toEqual(["o/r"]);
  });

  it("200: paginates until a short page and aggregates across repos", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([{ name: "o/a" }, { name: "o/b" }] as never);
    // o/a: a full page of 100, then a short page of 1 -> 101 issues; o/b: 1 issue
    const fullPage = Array.from({ length: 100 }, (_, i) => issueEntry({ number: i + 1 }));
    mockFetchSequence(
      githubJson(200, fullPage), // o/a page 1 (full -> keep paging)
      githubJson(200, [issueEntry({ number: 101 })]), // o/a page 2 (short -> stop)
      githubJson(200, [issueEntry({ number: 500 })]), // o/b page 1 (short -> stop)
    );
    const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues).toHaveLength(102);
    expect(body.repos).toEqual(["o/a", "o/b"]);
  });

  it("200: one repo's failure becomes a warning, other repos still sweep", async () => {
    vi.mocked(listWorkspaceRepositories).mockResolvedValue([{ name: "o/a" }, { name: "o/b" }] as never);
    mockFetchSequence(
      githubJson(404, { message: "Not Found" }), // o/a fails
      githubJson(200, [issueEntry({ number: 7 })]), // o/b ok
    );
    const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].number).toBe(7);
    expect(body.warnings.length).toBe(1);
    expect(body.warnings[0]).toMatch(/o\/a/);
  });

  it("200: a transport error on a repo is a warning, not a 500", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues).toHaveLength(0);
    expect(body.warnings[0]).toMatch(/Could not reach GitHub/);
  });

  it("sends the workspace GitHub token to GitHub, never returns it", async () => {
    const fetchMock = mockFetchSequence(githubJson(200, []));
    const res = await GET(req({ eveSessionId: EVE, token: SECRET }));
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${MOCK_TOKEN}`);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain(MOCK_TOKEN);
  });
});
