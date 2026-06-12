import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertIndexSnapshots: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertIndexSnapshots } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/index-snapshots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  repository_id: REPO,
  commit_sha: "abc123",
  indexed_at: "2026-06-12T00:00:00.000Z",
  source_count: 402,
  graph_edge_count: 8381,
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireBearer as any).mockResolvedValue({ workspaceId: WS, apiKeyId: "k1", teamId: null });
  (getRepository as any).mockResolvedValue({ id: REPO, workspaceId: WS });
  (insertIndexSnapshots as any).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/index-snapshots", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    (requireBearer as any).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + accepted count on valid snapshot", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(insertIndexSnapshots).toHaveBeenCalledWith([
      { workspace_id: WS, ...valid },
    ]);
  });

  it("404 when repo not in the key's workspace", async () => {
    (getRepository as any).mockResolvedValue(null);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(insertIndexSnapshots).not.toHaveBeenCalled();
  });

  it("400 on malformed snapshot", async () => {
    const res = await POST(req({ repository_id: REPO }));
    expect(res.status).toBe(400);
  });
});
