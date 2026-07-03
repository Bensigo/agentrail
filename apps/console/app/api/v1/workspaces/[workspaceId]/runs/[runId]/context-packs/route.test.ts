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
import {
  getContextPacksForRun,
  getContextPackItems,
} from "@agentrail/db-clickhouse";

const WS = "00000000-0000-0000-0000-000000000001";
const RUN = "00000000-0000-0000-0000-000000000002";
const PACK = "pack-derived-001";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/runs/${RUN}/context-packs`,
    { method: "GET" }
  );
}

function params() {
  return Promise.resolve({ workspaceId: WS, runId: RUN });
}

const samplePack = {
  workspace_id: WS,
  run_id: RUN,
  context_pack_id: PACK,
  token_budget: 8000,
  tokens_used: 4200,
  tokens_saved: 1800,
  anchors_extracted: 0,
  sources_considered: 2,
  occurred_at: new Date("2026-06-12T10:00:00.000Z"),
  precision_at_budget: 0,
  citation_coverage: 0,
  stale_count: 0,
  denied_count: 0,
  source_hash_list: [],
};

const sampleItems = [
  {
    workspace_id: WS,
    run_id: RUN,
    context_pack_id: PACK,
    item_path: "src/a.py",
    item_hash: "",
    included: 1,
    citation: "src/a.py:1-10",
    reason: "lexical match",
    score: 0.91,
    occurred_at: new Date("2026-06-12T10:00:00.000Z"),
  },
  {
    workspace_id: WS,
    run_id: RUN,
    context_pack_id: PACK,
    item_path: "src/b.py",
    item_hash: "",
    included: 0,
    citation: "",
    reason: "over budget",
    score: 0.12,
    occurred_at: new Date("2026-06-12T10:00:00.000Z"),
  },
  // Read-grounded live diagnostics (issue #1037) ride the same context_events
  // channel, tagged by reason. They must be split out of included/excluded.
  {
    workspace_id: WS,
    run_id: RUN,
    context_pack_id: PACK,
    item_path: "src/unread.py",
    item_hash: "",
    included: 1,
    citation: "",
    reason: "live_waste",
    score: 0,
    occurred_at: new Date("2026-06-12T10:00:00.000Z"),
  },
  {
    workspace_id: WS,
    run_id: RUN,
    context_pack_id: PACK,
    item_path: "src/self_fetched.py",
    item_hash: "",
    included: 0,
    citation: "",
    reason: "live_miss",
    score: 0,
    occurred_at: new Date("2026-06-12T10:00:00.000Z"),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getContextPacksForRun).mockResolvedValue([samplePack]);
  vi.mocked(getContextPackItems).mockResolvedValue(sampleItems);
});

describe("GET /api/v1/workspaces/[workspaceId]/runs/[runId]/context-packs", () => {
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

  it("200 with packs and their items split into included/excluded/waste/miss", async () => {
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.context_packs).toEqual([
      {
        context_pack_id: PACK,
        token_budget: 8000,
        tokens_used: 4200,
        tokens_saved: 1800,
        anchors_extracted: 0,
        sources_considered: 2,
        occurred_at: "2026-06-12T10:00:00.000Z",
        included: [
          {
            path: "src/a.py",
            citation: "src/a.py:1-10",
            reason: "lexical match",
            score: 0.91,
          },
        ],
        excluded: [{ path: "src/b.py", reason: "over budget" }],
        // live_waste / live_miss items are pulled out of the retrieval lists
        // and surfaced as read-grounded diagnostics (issue #1037 AC4).
        waste: [{ path: "src/unread.py" }],
        miss: [{ path: "src/self_fetched.py" }],
      },
    ]);
    expect(getContextPacksForRun).toHaveBeenCalledWith(WS, RUN);
    expect(getContextPackItems).toHaveBeenCalledWith(WS, RUN, PACK);
  });

  it("does not leak live_waste/live_miss markers into included/excluded", async () => {
    const res = await GET(req(), { params: params() });
    const json = await res.json();
    const pack = json.context_packs[0];
    const includedReasons = pack.included.map((i: { reason: string }) => i.reason);
    const excludedReasons = pack.excluded.map((i: { reason: string }) => i.reason);
    expect(includedReasons).not.toContain("live_waste");
    expect(excludedReasons).not.toContain("live_miss");
    expect(pack.included).toHaveLength(1);
    expect(pack.excluded).toHaveLength(1);
  });

  it("200 with empty list when no packs", async () => {
    vi.mocked(getContextPacksForRun).mockResolvedValue([]);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.context_packs).toEqual([]);
    expect(getContextPackItems).not.toHaveBeenCalled();
  });

  it("500 when ClickHouse query throws (no silent 200)", async () => {
    vi.mocked(getContextPacksForRun).mockRejectedValue(new Error("CH down"));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
