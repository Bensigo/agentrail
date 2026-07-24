/**
 * Tests for the bearer-authed wiki-pages hydration read endpoint (Repo Wiki
 * spec §4.4 contract 2). Hermetic: db-postgres queries and requireBearer are
 * mocked; no live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getRepositoryByName: vi.fn(),
  listWikiPages: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));

vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { getRepositoryByName, listWikiPages, touchApiKeyLastUsed } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { GET } from "./route";

const AUTH = { apiKeyId: "key-1", workspaceId: "ws-1", teamId: null };
const REPO_ID = "11111111-1111-1111-1111-111111111111";
const REPO_FULL_NAME = "acme/widgets";

function makeRequest(repo?: string): NextRequest {
  const url = new URL("http://localhost/api/v1/context/wiki-pages");
  if (repo !== undefined) url.searchParams.set("repo", repo);
  return new NextRequest(url, { headers: { authorization: "Bearer test-key" } });
}

function wikiPageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "page-1",
    workspaceId: "ws-1",
    repositoryId: REPO_ID,
    slug: "wiki/overview",
    title: "acme/widgets — overview",
    kind: "overview",
    bodyMd: "# Overview",
    skeleton: { files: [] },
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
  vi.mocked(requireBearer).mockResolvedValue(AUTH as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: REPO_ID } as never);
  vi.mocked(listWikiPages).mockResolvedValue([] as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
});

describe("GET /api/v1/context/wiki-pages", () => {
  it("returns the bearer-auth failure response untouched", async () => {
    const denied = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    vi.mocked(requireBearer).mockResolvedValue(denied as never);

    const res = await GET(makeRequest(REPO_FULL_NAME));

    expect(res.status).toBe(401);
    expect(listWikiPages).not.toHaveBeenCalled();
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("400s when repo is missing", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("repo");
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("404s when the repository is not in the key's workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);

    const res = await GET(makeRequest(REPO_FULL_NAME));

    expect(res.status).toBe(404);
    expect(getRepositoryByName).toHaveBeenCalledWith(AUTH.workspaceId, REPO_FULL_NAME);
    expect(listWikiPages).not.toHaveBeenCalled();
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("returns full pages (incl. bodyMd, skeleton, links, inputsHash, stale) under schemaVersion 1", async () => {
    vi.mocked(listWikiPages).mockResolvedValue([wikiPageRow()] as never);

    const res = await GET(makeRequest(REPO_FULL_NAME));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.repo).toBe(REPO_FULL_NAME);
    expect(body.pages).toEqual([
      {
        slug: "wiki/overview",
        title: "acme/widgets — overview",
        kind: "overview",
        bodyMd: "# Overview",
        skeleton: { files: [] },
        links: { related: [], dependsOn: [], dependedOnBy: [] },
        citations: ["README.md"],
        commitSha: "abc123",
        inputsHash: "sha256:deadbeef",
        model: "claude-haiku-4-5",
        writtenBy: "wiki-compiler",
        generatedAt: "2026-07-24T00:00:00.000Z",
        stale: false,
      },
    ]);
    expect(listWikiPages).toHaveBeenCalledWith(AUTH.workspaceId, REPO_ID);
    expect(touchApiKeyLastUsed).toHaveBeenCalledWith(AUTH.apiKeyId);
  });

  it("502s with a JSON error when the query throws", async () => {
    vi.mocked(listWikiPages).mockRejectedValue(new Error("db down") as never);

    const res = await GET(makeRequest(REPO_FULL_NAME));

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Upstream storage error");
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });
});
