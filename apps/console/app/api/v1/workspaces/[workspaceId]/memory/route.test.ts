import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listMemoryItems: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listMemoryItems } from "@agentrail/db-postgres";

// ── Helpers ────────────────────────────────────────────────────────────────
const WORKSPACE_ID = "ws-123";
const USER_ID = "user-1";

// A memory whose full body is longer than the 200-char preview window, so we
// can assert that masked callers never receive the tail.
const LONG_TAIL = " SENSITIVE-TAIL-VALUE-XYZ";
const LONG_CONTENT = "a".repeat(220) + LONG_TAIL;

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WORKSPACE_ID}/memory`
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

const memoryRow = {
  id: "mem-1",
  source: "review",
  type: "fact" as const,
  writtenBy: "review",
  repositoryName: "bensigo/agentrail",
  content: LONG_CONTENT,
  tags: ["testing"],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: null,
};

function mockMembership(role: string) {
  vi.mocked(getWorkspaceMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
  } as never);
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/v1/workspaces/:workspaceId/memory", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listMemoryItems).mockResolvedValue([memoryRow] as never);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
    expect(listMemoryItems).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not a workspace member", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(403);
    expect(listMemoryItems).not.toHaveBeenCalled();
  });

  it("returns FULL content to an owner", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    mockMembership("owner");
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    const item = json.items[0];
    expect(item.content).toBe(LONG_CONTENT);
    expect(item.content).toContain(LONG_TAIL);
    expect(item.content_masked).toBe(false);
    // v2 attribution fields are surfaced.
    expect(item.type).toBe("fact");
    expect(item.written_by).toBe("review");
  });

  it("returns FULL content to an admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    mockMembership("admin");
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.items[0].content).toBe(LONG_CONTENT);
    expect(json.items[0].content_masked).toBe(false);
  });

  it("masks full content for a plain member (preview only, no tail)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    mockMembership("member");
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    const item = json.items[0];
    // Response shape is preserved: both keys present, content is a string.
    expect(typeof item.content).toBe("string");
    expect(item.content_preview).toHaveLength(200);
    // The full body — specifically its sensitive tail — is NOT returned.
    expect(item.content).not.toContain(LONG_TAIL);
    expect(item.content.length).toBeLessThan(LONG_CONTENT.length);
    expect(item.content_masked).toBe(true);
  });

  it("masks full content for a viewer", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    mockMembership("viewer");
    const res = await GET(makeRequest(), makeParams());
    const json = await res.json();
    expect(json.items[0].content).not.toContain(LONG_TAIL);
    expect(json.items[0].content_masked).toBe(true);
  });

  it("returns 500 when the query throws", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: USER_ID } } as never);
    mockMembership("owner");
    vi.mocked(listMemoryItems).mockRejectedValue(new Error("db down"));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(500);
  });
});
