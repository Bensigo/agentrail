import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-clickhouse", () => ({
  insertCostEvents: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getRepository: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertCostEvents } from "@agentrail/db-clickhouse";
import { getRepository } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const REPO = "00000000-0000-0000-0000-000000000010";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/cost-events", {
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
  cost_type: "model_call",
  tokens: 1000,
  cost_usd: 0.002,
  model: "claude-sonnet-4-6",
  occurred_at: "2026-06-12T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({ workspaceId: WS, apiKeyId: KEY, teamId: TEAM } as never);
  vi.mocked(getRepository).mockResolvedValue({ id: REPO, workspaceId: WS } as never);
  vi.mocked(insertCostEvents).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/cost-events", () => {
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
    expect(insertCostEvents).toHaveBeenCalledWith([
      {
        workspace_id: WS,
        api_key_id: KEY,
        team_id: TEAM,
        repository_id: valid.repository_id,
        run_id: valid.run_id,
        cost_type: valid.cost_type,
        tokens: valid.tokens,
        cost_usd: valid.cost_usd,
        model: valid.model,
        occurred_at: valid.occurred_at,
        phase: "",
        input_tokens: 0,
        output_tokens: 0,
        cache_tokens: 0,
        cache_creation_tokens: 0,
        // #1337 PR②: absent price_source in the request defaults to "".
        price_source: "",
      },
    ]);
  });

  it("202 + passes through price_source when present (#1337 PR②)", async () => {
    const withSource = { ...valid, price_source: "gateway" };
    const res = await POST(req(withSource));
    expect(res.status).toBe(202);
    expect(insertCostEvents).toHaveBeenCalledWith([
      expect.objectContaining({ price_source: "gateway" }),
    ]);
  });

  it("null price_source (Python None) defaults to \"\" rather than breaking validation", async () => {
    const withNull = { ...valid, price_source: null };
    const res = await POST(req(withNull));
    expect(res.status).toBe(202);
    expect(insertCostEvents).toHaveBeenCalledWith([
      expect.objectContaining({ price_source: "" }),
    ]);
  });

  it("202 + passes through phase and token split fields", async () => {
    const withSplit = {
      ...valid,
      phase: "execute",
      input_tokens: 200,
      output_tokens: 80,
      cache_tokens: 40,
      cache_creation_tokens: 15,
    };
    const res = await POST(req(withSplit));
    expect(res.status).toBe(202);
    expect(insertCostEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        phase: "execute",
        input_tokens: 200,
        output_tokens: 80,
        cache_tokens: 40,
        cache_creation_tokens: 15,
      }),
    ]);
  });

  it("404 when repo not in the key's workspace", async () => {
    vi.mocked(getRepository).mockResolvedValue(null as never);
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(insertCostEvents).not.toHaveBeenCalled();
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
