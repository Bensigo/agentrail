/**
 * Tests for the Jace-coordinator repo-wiki route (Repo Wiki spec §4.4
 * contract 3). Auth + tenant-resolution coverage mirrors
 * runner/workspace-memory/route.test.ts's own structure exactly (same
 * requireJaceConsoleSecret + eveSessionId -> jace_sessions chain); the rest
 * covers repo disambiguation and the three modes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getRepositoryByName: vi.fn(),
  getWikiPage: vi.fn(),
  listWikiPages: vi.fn(),
  listWorkspaceRepositories: vi.fn(),
  searchWikiPages: vi.fn(),
  WIKI_SEARCH_DEFAULT_LIMIT: 5,
  WIKI_SEARCH_MAX_LIMIT: 10,
}));

import { GET } from "./route";
import {
  getJaceSessionByEveSessionId,
  getRepositoryByName,
  getWikiPage,
  listWikiPages,
  listWorkspaceRepositories,
  searchWikiPages,
} from "@agentrail/db-postgres";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockGetRepoByName = vi.mocked(getRepositoryByName);
const mockGetPage = vi.mocked(getWikiPage);
const mockListPages = vi.mocked(listWikiPages);
const mockListRepos = vi.mocked(listWorkspaceRepositories);
const mockSearch = vi.mocked(searchWikiPages);

const WS = "00000000-0000-0000-0000-000000000001";
const REPO_ID = "00000000-0000-0000-0000-000000000010";
const REPO_FULL_NAME = "acme/widgets";
const EVE_SESSION_ID = "eve-session-1";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(opts: {
  eveSessionId?: string;
  mode?: string;
  repo?: string;
  slug?: string;
  query?: string;
  limit?: string;
  token?: string;
} = {}): NextRequest {
  const { eveSessionId, mode, repo, slug, query, limit, token } = opts;
  const params = new URLSearchParams();
  if (eveSessionId !== undefined) params.set("eveSessionId", eveSessionId);
  if (mode !== undefined) params.set("mode", mode);
  if (repo !== undefined) params.set("repo", repo);
  if (slug !== undefined) params.set("slug", slug);
  if (query !== undefined) params.set("query", query);
  if (limit !== undefined) params.set("limit", limit);
  const qs = params.toString();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(
    `http://localhost/api/v1/runner/repo-wiki${qs ? `?${qs}` : ""}`,
    { method: "GET", headers }
  );
}

function wikiPage(overrides: Record<string, unknown> = {}) {
  return {
    id: "page-1",
    workspaceId: WS,
    repositoryId: REPO_ID,
    slug: "wiki/overview",
    title: "acme/widgets — overview",
    kind: "overview",
    bodyMd: "# Overview",
    skeleton: {},
    links: { related: [], dependsOn: [], dependedOnBy: [] },
    citations: ["README.md"],
    commitSha: "abc123",
    inputsHash: "sha256:deadbeef",
    model: "claude-haiku-4-5",
    writtenBy: "wiki-compiler",
    generatedAt: new Date("2026-07-24T00:00:00.000Z"),
    stale: false,
    createdAt: new Date("2026-07-24T00:00:00.000Z"),
    updatedAt: new Date("2026-07-24T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockGetSession.mockResolvedValue({ workspaceId: WS } as never);
  mockGetRepoByName.mockResolvedValue({ id: REPO_ID, name: REPO_FULL_NAME } as never);
  mockListRepos.mockResolvedValue([{ id: REPO_ID, name: REPO_FULL_NAME }] as never);
  mockListPages.mockResolvedValue([] as never);
  mockGetPage.mockResolvedValue(null as never);
  mockSearch.mockResolvedValue([] as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/repo-wiki", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never touches the db", async () => {
      delete process.env[ENV_KEY];
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent", async () => {
      const res = await GET(req({ eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(401);
    });

    it("401 on a wrong secret", async () => {
      const res = await GET(
        req({ token: "wrong-secret", eveSessionId: EVE_SESSION_ID, mode: "list" })
      );
      expect(res.status).toBe(401);
    });
  });

  describe("tenant resolution (eveSessionId -> jace_sessions ledger)", () => {
    it("400 when eveSessionId is missing", async () => {
      const res = await GET(req({ token: SECRET, mode: "list" }));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("400 when eveSessionId is blank/whitespace", async () => {
      const res = await GET(req({ token: SECRET, eveSessionId: "   ", mode: "list" }));
      expect(res.status).toBe(400);
    });

    it("404 when no session exists for this eveSessionId", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(404);
      expect(mockListRepos).not.toHaveBeenCalled();
    });

    it("404 when the session has no resolved workspace yet", async () => {
      mockGetSession.mockResolvedValue({ workspaceId: null } as never);
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(404);
      expect(mockListRepos).not.toHaveBeenCalled();
    });
  });

  describe("mode validation", () => {
    it("400 when mode is missing", async () => {
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID }));
      expect(res.status).toBe(400);
    });

    it("400 when mode is not one of list|get|search", async () => {
      const res = await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "bogus" })
      );
      expect(res.status).toBe(400);
    });
  });

  describe("repo resolution", () => {
    it("resolves an explicit repo scoped to the workspace", async () => {
      await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list", repo: REPO_FULL_NAME })
      );
      expect(mockGetRepoByName).toHaveBeenCalledWith(WS, REPO_FULL_NAME);
      expect(mockListRepos).not.toHaveBeenCalled();
    });

    it("404 when the explicit repo is not found in the workspace", async () => {
      mockGetRepoByName.mockResolvedValue(null as never);
      const res = await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list", repo: "nope/nope" })
      );
      expect(res.status).toBe(404);
    });

    it("auto-selects the sole repo when repo is omitted and the workspace has exactly one", async () => {
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(200);
      expect(mockListPages).toHaveBeenCalledWith(WS, REPO_ID);
    });

    it("400 repo_required with an empty repos list when the workspace has zero repos", async () => {
      mockListRepos.mockResolvedValue([] as never);
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: "repo_required", repos: [] });
    });

    it("400 repo_required listing full names when the workspace has multiple repos", async () => {
      mockListRepos.mockResolvedValue([
        { id: "r1", name: "acme/widgets" },
        { id: "r2", name: "acme/gadgets" },
      ] as never);
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ error: "repo_required", repos: ["acme/widgets", "acme/gadgets"] });
    });
  });

  describe("mode=list", () => {
    it("200s with pages projected without bodyMd/citations", async () => {
      mockListPages.mockResolvedValue([wikiPage()] as never);
      const res = await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list", repo: REPO_FULL_NAME })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        schemaVersion: 1,
        repo: REPO_FULL_NAME,
        mode: "list",
        pages: [
          {
            slug: "wiki/overview",
            title: "acme/widgets — overview",
            kind: "overview",
            stale: false,
            commitSha: "abc123",
            generatedAt: "2026-07-24T00:00:00.000Z",
            model: "claude-haiku-4-5",
          },
        ],
      });
    });

    it("502s when the store errors", async () => {
      mockListPages.mockRejectedValue(new Error("pg down"));
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(502);
    });
  });

  describe("mode=get", () => {
    it("400 when slug is missing", async () => {
      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get" }));
      expect(res.status).toBe(400);
      expect(mockGetPage).not.toHaveBeenCalled();
    });

    it("404 when the page does not exist", async () => {
      mockGetPage.mockResolvedValue(null as never);
      const res = await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: "wiki/overview" })
      );
      expect(res.status).toBe(404);
    });

    it("200s with full bodyMd and citations (the only mode that includes citations)", async () => {
      mockGetPage.mockResolvedValue(wikiPage() as never);
      const res = await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: "wiki/overview" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockGetPage).toHaveBeenCalledWith(WS, REPO_ID, "wiki/overview");
      expect(body.pages).toEqual([
        {
          slug: "wiki/overview",
          title: "acme/widgets — overview",
          kind: "overview",
          stale: false,
          commitSha: "abc123",
          generatedAt: "2026-07-24T00:00:00.000Z",
          model: "claude-haiku-4-5",
          bodyMd: "# Overview",
          citations: ["README.md"],
        },
      ]);
    });
  });

  describe("mode=search", () => {
    it("passes an empty query and the default limit through when both are omitted", async () => {
      await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search" }));
      expect(mockSearch).toHaveBeenCalledWith(WS, REPO_ID, "", 5);
    });

    it("clamps a limit above the max down to WIKI_SEARCH_MAX_LIMIT", async () => {
      await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search", limit: "999" })
      );
      expect(mockSearch).toHaveBeenCalledWith(WS, REPO_ID, "", 10);
    });

    it("truncates bodyMd to 2000 chars and omits citations", async () => {
      const longBody = "x".repeat(3000);
      mockSearch.mockResolvedValue([wikiPage({ bodyMd: longBody })] as never);
      const res = await GET(
        req({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search", query: "overview" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockSearch).toHaveBeenCalledWith(WS, REPO_ID, "overview", 5);
      expect(body.pages[0].bodyMd).toHaveLength(2000);
      expect(body.pages[0].bodyMd).toBe("x".repeat(2000));
      expect(body.pages[0]).not.toHaveProperty("citations");
    });
  });
});
