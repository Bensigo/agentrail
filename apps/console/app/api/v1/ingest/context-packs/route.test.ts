import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertContextPacks: vi.fn(),
  insertContextEvents: vi.fn(),
  deriveContextPackId: vi.fn(
    (ws: string, run: string, at: string) => `derived:${ws}:${run}:${at}`
  ),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertContextPacks, insertContextEvents } from "@agentrail/db-clickhouse";
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
  vi.mocked(insertContextEvents).mockResolvedValue(0);
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
        tokens_saved: 0,
        anchors_extracted: 0,
        sources_considered: valid.sources_considered,
        occurred_at: valid.occurred_at,
        precision_at_budget: 0,
        citation_coverage: 0,
        stale_count: 0,
        denied_count: 0,
        source_hash_list: [],
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

  it("202 without items does not write context events", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(insertContextEvents).not.toHaveBeenCalled();
  });

  it("202 with items writes context_events rows keyed by derived pack id", async () => {
    vi.mocked(insertContextEvents).mockResolvedValue(2);
    const res = await POST(
      req({
        ...valid,
        items: [
          { path: "src/a.py", reason: "lexical match", score: 0.91 },
          { path: "src/b.py", included: false },
        ],
      })
    );
    expect(res.status).toBe(202);
    expect(insertContextEvents).toHaveBeenCalledWith([
      {
        workspace_id: WS,
        run_id: valid.run_id,
        context_pack_id: `derived:${WS}:${valid.run_id}:${valid.occurred_at}`,
        item_path: "src/a.py",
        item_hash: "",
        included: 1,
        citation: "",
        reason: "lexical match",
        score: 0.91,
        occurred_at: valid.occurred_at,
      },
      {
        workspace_id: WS,
        run_id: valid.run_id,
        context_pack_id: `derived:${WS}:${valid.run_id}:${valid.occurred_at}`,
        item_path: "src/b.py",
        item_hash: "",
        included: 0,
        citation: "",
        reason: "",
        score: 0,
        occurred_at: valid.occurred_at,
      },
    ]);
  });

  it("202 with empty items array does not write context events", async () => {
    const res = await POST(req({ ...valid, items: [] }));
    expect(res.status).toBe(202);
    expect(insertContextEvents).not.toHaveBeenCalled();
  });

  it("400 on malformed items (path missing)", async () => {
    const res = await POST(req({ ...valid, items: [{ reason: "no path" }] }));
    expect(res.status).toBe(400);
    expect(insertContextPacks).not.toHaveBeenCalled();
  });

  it("400 when items exceed 100", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ path: `f${i}.py` }));
    const res = await POST(req({ ...valid, items }));
    expect(res.status).toBe(400);
  });

  it("502 when context event insert fails", async () => {
    vi.mocked(insertContextEvents).mockRejectedValue(new Error("CH down"));
    const res = await POST(req({ ...valid, items: [{ path: "src/a.py" }] }));
    expect(res.status).toBe(502);
  });

  it("202 with all five quality fields — passes them to insertContextPacks", async () => {
    const withQuality = {
      ...valid,
      precision_at_budget: 0.85,
      citation_coverage: 0.72,
      stale_count: 3,
      denied_count: 1,
      source_hash_list: ["abc123", "def456"],
    };
    const res = await POST(req(withQuality));
    expect(res.status).toBe(202);
    expect(insertContextPacks).toHaveBeenCalledWith([
      expect.objectContaining({
        precision_at_budget: 0.85,
        citation_coverage: 0.72,
        stale_count: 3,
        denied_count: 1,
        source_hash_list: ["abc123", "def456"],
      }),
    ]);
  });

  it("202 without quality fields — defaults to 0/[] in insertContextPacks", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(insertContextPacks).toHaveBeenCalledWith([
      expect.objectContaining({
        precision_at_budget: 0,
        citation_coverage: 0,
        stale_count: 0,
        denied_count: 0,
        source_hash_list: [],
      }),
    ]);
  });

  it("400 when precision_at_budget is not a number", async () => {
    const res = await POST(req({ ...valid, precision_at_budget: "high" }));
    expect(res.status).toBe(400);
  });

  it("400 when source_hash_list contains non-strings", async () => {
    const res = await POST(req({ ...valid, source_hash_list: ["ok", 42] }));
    expect(res.status).toBe(400);
  });
});
