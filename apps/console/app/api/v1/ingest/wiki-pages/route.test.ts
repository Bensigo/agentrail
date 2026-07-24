import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getRepositoryByName: vi.fn(),
  upsertWikiPages: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  insertWikiCompileEvents: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { getRepositoryByName, upsertWikiPages } from "@agentrail/db-postgres";
import { insertWikiCompileEvents } from "@agentrail/db-clickhouse";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO_ID = "00000000-0000-0000-0000-000000000010";
const REPO_FULL_NAME = "acme/widgets";
const KEY = "k1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/wiki-pages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    slug: "wiki/overview",
    title: "acme/widgets — overview",
    kind: "overview",
    bodyMd: "# Overview\n\nThis repo builds widgets.",
    commitSha: "abc123",
    inputsHash: "sha256:deadbeef",
    generatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

const valid = {
  repoFullName: REPO_FULL_NAME,
  pages: [page()],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: null,
  } as never);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: REPO_ID, workspaceId: WS } as never);
  vi.mocked(upsertWikiPages).mockResolvedValue({ inserted: 1, replaced: 0 });
  vi.mocked(insertWikiCompileEvents).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/wiki-pages", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
    expect(upsertWikiPages).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON", async () => {
    const badReq = new NextRequest("http://localhost/api/v1/ingest/wiki-pages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ar_test" },
      body: "not json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  it("400 on missing repoFullName", async () => {
    const { repoFullName: _omit, ...rest } = valid;
    const res = await POST(req(rest));
    expect(res.status).toBe(400);
    expect(getRepositoryByName).not.toHaveBeenCalled();
  });

  it("400 on missing pages array", async () => {
    const res = await POST(req({ repoFullName: REPO_FULL_NAME }));
    expect(res.status).toBe(400);
  });

  it("400 on a page with an out-of-enum kind", async () => {
    const res = await POST(req({ ...valid, pages: [page({ kind: "concept" })] }));
    expect(res.status).toBe(400);
    expect(upsertWikiPages).not.toHaveBeenCalled();
  });

  it("400 on a page missing a required field (inputsHash)", async () => {
    const bad = page();
    delete (bad as Record<string, unknown>).inputsHash;
    const res = await POST(req({ ...valid, pages: [bad] }));
    expect(res.status).toBe(400);
  });

  it("400 when the batch exceeds the page limit", async () => {
    const pages = Array.from({ length: 41 }, (_, i) =>
      page({ slug: `wiki/unit/u${i}`, kind: "unit" })
    );
    const res = await POST(req({ ...valid, pages }));
    expect(res.status).toBe(400);
    expect(upsertWikiPages).not.toHaveBeenCalled();
  });

  it("404 when the repo is not in the workspace", async () => {
    vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(getRepositoryByName).toHaveBeenCalledWith(WS, REPO_FULL_NAME);
    expect(upsertWikiPages).not.toHaveBeenCalled();
  });

  it("422 + recorded reason when a page body_md contains a credential, and does not upsert", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = {
      ...valid,
      pages: [page({ bodyMd: "prod aws key is AKIAIOSFODNN7EXAMPLE, do not lose it" })],
    };
    const res = await POST(req(body));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/credential-shaped/i);
    expect(json.reason).toContain("aws_access_key_id");
    expect(json.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(upsertWikiPages).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("200 + {inserted, replaced} and upserts with the resolved repository id", async () => {
    vi.mocked(upsertWikiPages).mockResolvedValue({ inserted: 0, replaced: 1 });

    const res = await POST(req(valid));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 0, replaced: 1 });
    expect(upsertWikiPages).toHaveBeenCalledWith({
      workspaceId: WS,
      repositoryId: REPO_ID,
      pages: [
        {
          slug: "wiki/overview",
          title: "acme/widgets — overview",
          kind: "overview",
          bodyMd: "# Overview\n\nThis repo builds widgets.",
          skeleton: undefined,
          links: undefined,
          citations: undefined,
          commitSha: "abc123",
          inputsHash: "sha256:deadbeef",
          model: undefined,
          writtenBy: undefined,
          generatedAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    });
  });

  it("forwards optional fields (skeleton, links, citations, model, writtenBy) through unchanged", async () => {
    const full = page({
      skeleton: { files: ["a.ts"] },
      links: { related: ["wiki/overview"], dependsOn: [], dependedOnBy: [] },
      citations: ["a.ts", "b.ts"],
      model: "claude-haiku-4-5",
      writtenBy: "wiki-compiler",
    });
    await POST(req({ ...valid, pages: [full] }));
    expect(upsertWikiPages).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [
          expect.objectContaining({
            skeleton: { files: ["a.ts"] },
            links: { related: ["wiki/overview"], dependsOn: [], dependedOnBy: [] },
            citations: ["a.ts", "b.ts"],
            model: "claude-haiku-4-5",
            writtenBy: "wiki-compiler",
          }),
        ],
      })
    );
  });

  it("502 when the Postgres upsert throws", async () => {
    vi.mocked(upsertWikiPages).mockRejectedValue(new Error("db down"));
    const res = await POST(req(valid));
    expect(res.status).toBe(502);
  });

  describe("compileEvent -> ClickHouse", () => {
    it("is not called when compileEvent is absent", async () => {
      await POST(req(valid));
      expect(insertWikiCompileEvents).not.toHaveBeenCalled();
    });

    it("inserts a snake_case compile event scoped to the resolved workspace/repo when present", async () => {
      const body = {
        ...valid,
        compileEvent: {
          commitSha: "abc123",
          pagesWritten: 3,
          pagesReused: 21,
          costUsd: 0.04,
          model: "claude-haiku-4-5",
          durationMs: 5200,
        },
      };
      const res = await POST(req(body));

      expect(res.status).toBe(200);
      expect(insertWikiCompileEvents).toHaveBeenCalledTimes(1);
      const [[events]] = vi.mocked(insertWikiCompileEvents).mock.calls;
      expect(events).toEqual([
        {
          workspace_id: WS,
          repository_id: REPO_ID,
          commit_sha: "abc123",
          pages_written: 3,
          pages_reused: 21,
          cost_usd: 0.04,
          model: "claude-haiku-4-5",
          duration_ms: 5200,
          created_at: expect.any(String),
        },
      ]);
    });

    it("400 on a malformed compileEvent", async () => {
      const res = await POST(req({ ...valid, compileEvent: { commitSha: "abc123" } }));
      expect(res.status).toBe(400);
      expect(upsertWikiPages).not.toHaveBeenCalled();
    });

    it("still returns 200 with the Postgres result when the ClickHouse insert throws (non-fatal)", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(insertWikiCompileEvents).mockRejectedValue(new Error("ch down"));
      vi.mocked(upsertWikiPages).mockResolvedValue({ inserted: 1, replaced: 0 });

      const body = {
        ...valid,
        compileEvent: {
          commitSha: "abc123",
          pagesWritten: 1,
          pagesReused: 0,
          costUsd: 0.01,
          model: "claude-haiku-4-5",
          durationMs: 900,
        },
      };
      const res = await POST(req(body));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ inserted: 1, replaced: 0 });
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
