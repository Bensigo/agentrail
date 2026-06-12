import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertContextPacks: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertContextPacks } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/context-packs", {
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
  run_id: "run-abc",
  context_pack_id: "cp-001",
  token_budget: 8000,
  tokens_used: 4200,
  sources_considered: 15,
  occurred_at: "2026-06-12T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({ workspaceId: WS } as never);
  vi.mocked(getRepository).mockResolvedValue({ id: REPO, workspaceId: WS } as never);
  vi.mocked(insertContextPacks).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/context-packs", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + accepted count on valid single event", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(insertContextPacks).toHaveBeenCalledWith([
      {
        workspace_id: WS,
        run_id: valid.run_id,
        token_budget: valid.token_budget,
        tokens_used: valid.tokens_used,
        anchors_extracted: 0,
        sources_considered: valid.sources_considered,
        occurred_at: valid.occurred_at,
      },
    ]);
  });

  it("202 with anchors_extracted when provided", async () => {
    vi.mocked(insertContextPacks).mockResolvedValue(1);
    const res = await POST(req({ ...valid, anchors_extracted: 5 }));
    expect(res.status).toBe(202);
    expect(insertContextPacks).toHaveBeenCalledWith([
      expect.objectContaining({ anchors_extracted: 5 }),
    ]);
  });

  it("404 when repo not in the key's workspace", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(insertContextPacks).not.toHaveBeenCalled();
  });

  it("400 on malformed body (missing required field)", async () => {
    const res = await POST(req({ repository_id: REPO, run_id: "run-abc" }));
    expect(res.status).toBe(400);
  });

  it("400 on batch exceeding 100 items", async () => {
    const batch = Array.from({ length: 101 }, () => ({ ...valid }));
    const res = await POST(req(batch));
    expect(res.status).toBe(400);
  });
});
