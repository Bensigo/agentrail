/**
 * Tests for the bearer-authed memory-items read endpoint (issue #1071).
 *
 * Hermetic: db-postgres queries and requireBearer are mocked; no live DB.
 * The AC3 contrast is asserted here too — this machine route returns FULL
 * content with no `content_masked` key, unlike the session-authed
 * workspaces/[workspaceId]/memory route (which this PR does not touch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
  listMemoryItems: vi.fn(),
  touchApiKeyLastUsed: vi.fn(),
}));

vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import {
  getRepository,
  listMemoryItems,
  touchApiKeyLastUsed,
} from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { GET } from "./route";

const AUTH = {
  apiKeyId: "key-1",
  workspaceId: "ws-1",
  teamId: null,
};

const REPO_ID = "11111111-1111-1111-1111-111111111111";

function makeRequest(repositoryId?: string): NextRequest {
  const url = new URL("http://localhost/api/v1/context/memory-items");
  if (repositoryId !== undefined) {
    url.searchParams.set("repository_id", repositoryId);
  }
  return new NextRequest(url, {
    headers: { authorization: "Bearer test-key" },
  });
}

function memRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    workspaceId: "ws-1",
    repositoryId: REPO_ID,
    source: "review",
    content: "Long secret-free memory content that must arrive unmasked.",
    type: "fact",
    writtenBy: "review",
    tags: ["context"],
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastUsedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue(AUTH as never);
  vi.mocked(getRepository).mockResolvedValue({ id: REPO_ID } as never);
  vi.mocked(listMemoryItems).mockResolvedValue([] as never);
  vi.mocked(touchApiKeyLastUsed).mockResolvedValue(undefined as never);
});

describe("GET /api/v1/context/memory-items", () => {
  it("returns the bearer-auth failure response untouched", async () => {
    const denied = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    vi.mocked(requireBearer).mockResolvedValue(denied as never);

    const res = await GET(makeRequest(REPO_ID));

    expect(res.status).toBe(401);
    expect(listMemoryItems).not.toHaveBeenCalled();
    expect(getRepository).not.toHaveBeenCalled();
  });

  it("400s when repository_id is missing", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("repository_id");
    expect(getRepository).not.toHaveBeenCalled();
  });

  it("404s when the repository is not in the key's workspace", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);

    const res = await GET(makeRequest(REPO_ID));

    expect(res.status).toBe(404);
    expect(getRepository).toHaveBeenCalledWith(AUTH.workspaceId, REPO_ID);
    expect(listMemoryItems).not.toHaveBeenCalled();
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it("returns unmasked snake_case items for the repo plus workspace-wide rows", async () => {
    vi.mocked(listMemoryItems).mockResolvedValue([
      memRow({ id: "mem-repo", repositoryId: REPO_ID }),
      memRow({
        id: "mem-workspace",
        repositoryId: null,
        content: "Workspace-wide memory with no repository.",
        type: "decision",
        writtenBy: "jace",
      }),
      memRow({
        id: "mem-other-repo",
        repositoryId: "22222222-2222-2222-2222-222222222222",
      }),
    ] as never);

    const res = await GET(makeRequest(REPO_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([
      "mem-repo",
      "mem-workspace",
    ]);

    const first = body.items[0];
    // Full content, machine trust — and NO masking key (AC3 contrast with the
    // session-authed workspaces route).
    expect(first.content).toBe(
      "Long secret-free memory content that must arrive unmasked."
    );
    expect(first).not.toHaveProperty("content_masked");
    // snake_case serialization matches _normalize_memory_item's expected keys.
    expect(first).toEqual({
      id: "mem-repo",
      type: "fact",
      written_by: "review",
      source: "review",
      content: "Long secret-free memory content that must arrive unmasked.",
      tags: ["context"],
      created_at: "2026-07-01T00:00:00.000Z",
    });

    expect(touchApiKeyLastUsed).toHaveBeenCalledWith(AUTH.apiKeyId);
  });

  it("500s with a JSON error when the query throws", async () => {
    vi.mocked(listMemoryItems).mockRejectedValue(new Error("db down") as never);

    const res = await GET(makeRequest(REPO_ID));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to load memory items");
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });
});
