import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  listMemoryItemsByRunId: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listMemoryItemsByRunId,
} from "@agentrail/db-postgres";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "00000000-0000-0000-0000-000000000002";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/memory`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

const sampleItems = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    workspaceId: WS,
    source: "review",
    content: "x".repeat(300),
    tags: [`run:${RUN}`, "failure-pattern"],
    createdAt: new Date("2026-06-12T10:00:00Z"),
    lastUsedAt: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(listMemoryItemsByRunId).mockResolvedValue(sampleItems as never);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/memory", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when user not a member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("200 with serialized items (preview truncated to 200 chars)", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      id: sampleItems[0].id,
      source: "review",
      tags: [`run:${RUN}`, "failure-pattern"],
      created_at: "2026-06-12T10:00:00.000Z",
      last_used_at: null,
    });
    expect(json.items[0].content_preview).toHaveLength(200);
    expect(json.items[0].content).toHaveLength(300);
    expect(listMemoryItemsByRunId).toHaveBeenCalledWith(WS, RUN);
  });

  it("200 with empty items when the run has no memory", async () => {
    vi.mocked(listMemoryItemsByRunId).mockResolvedValue([] as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(0);
  });

  it("500 when the DB query throws (no silent 200)", async () => {
    vi.mocked(listMemoryItemsByRunId).mockRejectedValue(new Error("pg down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
