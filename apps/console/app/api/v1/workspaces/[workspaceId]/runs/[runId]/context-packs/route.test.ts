import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
}));
vi.mock("@agentrail/db-clickhouse", () => ({
  getContextPacksForRun: vi.fn(),
  getContextPackItems: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getContextPacksForRun, getContextPackItems } from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "run-abc-123";
const PACK_ID = "pack-id-001";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/context-packs`
  );
}

function makeParams() {
  return { params: Promise.resolve({ workspaceId: WS, runId: RUN }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ workspaceId: WS } as never);
  vi.mocked(getContextPacksForRun).mockResolvedValue([
    {
      workspace_id: WS,
      run_id: RUN,
      context_pack_id: PACK_ID,
      token_budget: 8000,
      tokens_used: 4200,
      anchors_extracted: 3,
      sources_considered: 15,
      occurred_at: new Date("2026-06-12T10:00:00.000Z"),
    },
  ]);
  vi.mocked(getContextPackItems).mockResolvedValue([
    {
      workspace_id: WS,
      run_id: RUN,
      context_pack_id: PACK_ID,
      item_path: "src/a.py",
      item_hash: "abc123",
      included: 1,
      citation: "",
      reason: "anchor match",
      score: 0.9,
      occurred_at: new Date("2026-06-12T10:00:00.000Z"),
    },
    {
      workspace_id: WS,
      run_id: RUN,
      context_pack_id: PACK_ID,
      item_path: "src/b.py",
      item_hash: "def456",
      included: 0,
      citation: "",
      reason: "low relevance",
      score: 0.2,
      occurred_at: new Date("2026-06-12T10:00:00.000Z"),
    },
  ]);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/context-packs", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), makeParams());
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), makeParams());
    expect(res.status).toBe(403);
  });

  it("200 with packs and items split into included/excluded", async () => {
    const res = await GET(req(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("context_packs");
    const packs = body.context_packs;
    expect(packs).toHaveLength(1);

    const pack = packs[0];
    expect(pack.context_pack_id).toBe(PACK_ID);
    expect(pack.token_budget).toBe(8000);
    expect(pack.tokens_used).toBe(4200);
    expect(pack.anchors_extracted).toBe(3);
    expect(pack.sources_considered).toBe(15);
    expect(pack.occurred_at).toBe("2026-06-12T10:00:00.000Z");

    // included: src/a.py (included=1)
    expect(pack.included).toHaveLength(1);
    expect(pack.included[0]).toMatchObject({
      path: "src/a.py",
      reason: "anchor match",
      score: 0.9,
    });

    // excluded: src/b.py (included=0)
    expect(pack.excluded).toHaveLength(1);
    expect(pack.excluded[0]).toMatchObject({
      path: "src/b.py",
      reason: "low relevance",
    });
  });

  it("200 with empty context_packs when ClickHouse throws", async () => {
    vi.mocked(getContextPacksForRun).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ context_packs: [] });
  });

  it("calls getContextPackItems for each pack", async () => {
    await GET(req(), makeParams());
    expect(getContextPackItems).toHaveBeenCalledWith(WS, RUN, PACK_ID);
  });
});
