import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  insertEvalArmMetrics: vi.fn(),
}));
vi.mock("../../../../../lib/bearer-auth", () => ({
  requireBearer: vi.fn(),
}));

import { POST } from "./route";
import { insertEvalArmMetrics } from "@agentrail/db-postgres";
import { requireBearer } from "../../../../../lib/bearer-auth";

const WS = "00000000-0000-0000-0000-000000000001";
const KEY = "k1";
const TEAM = "t1";

function req(body: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/ingest/eval-arm-metrics", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withAuth ? { Authorization: "Bearer ar_test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  run_id: "eval-2026-06-23",
  arm: "full",
  repetitions: 10,
  solved_count: 8,
  failed_count: 2,
  solve_rate: 0.8,
  spread: 0.12,
  total_input_tokens: 1000,
  total_output_tokens: 400,
  total_cache_tokens: 200,
  total_cache_creation_tokens: 50,
  total_tokens: 1650,
  total_cost_usd: 0.42,
  dollars_per_solved: 0.0525,
  gate_passed_count: 9,
  false_green_count: 1,
  false_green_rate: 0.1111,
  strata: [
    {
      difficulty: "hard",
      repetitions: 5,
      solved_count: 3,
      failed_count: 2,
      solve_rate: 0.6,
      total_cost_usd: 0.3,
      dollars_per_solved: 0.1,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBearer).mockResolvedValue({
    workspaceId: WS,
    apiKeyId: KEY,
    teamId: TEAM,
  } as never);
  vi.mocked(insertEvalArmMetrics).mockResolvedValue(1);
});

describe("POST /api/v1/ingest/eval-arm-metrics", () => {
  it("401 when requireBearer rejects", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireBearer).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );
    const res = await POST(req(valid, false));
    expect(res.status).toBe(401);
  });

  it("202 + accepted count, mapping snake_case to camelCase", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(insertEvalArmMetrics).toHaveBeenCalledWith({
      workspaceId: WS,
      rows: [
        {
          runId: valid.run_id,
          arm: valid.arm,
          repetitions: 10,
          solvedCount: 8,
          failedCount: 2,
          solveRate: 0.8,
          spread: 0.12,
          totalInputTokens: 1000,
          totalOutputTokens: 400,
          totalCacheTokens: 200,
          totalCacheCreationTokens: 50,
          totalTokens: 1650,
          totalCostUsd: 0.42,
          dollarsPerSolved: 0.0525,
          gatePassedCount: 9,
          falseGreenCount: 1,
          falseGreenRate: 0.1111,
          strata: valid.strata,
        },
      ],
    });
  });

  it("preserves null dollars_per_solved and false_green_rate (undefined denominator)", async () => {
    const allFailed = {
      ...valid,
      solved_count: 0,
      failed_count: 10,
      solve_rate: 0,
      dollars_per_solved: null,
      gate_passed_count: 0,
      false_green_count: 0,
      false_green_rate: null,
    };
    const res = await POST(req(allFailed));
    expect(res.status).toBe(202);
    expect(insertEvalArmMetrics).toHaveBeenCalledWith({
      workspaceId: WS,
      rows: [
        expect.objectContaining({
          dollarsPerSolved: null,
          falseGreenRate: null,
        }),
      ],
    });
  });

  it("defaults missing strata to []", async () => {
    const { strata: _omit, ...noStrata } = valid;
    const res = await POST(req(noStrata));
    expect(res.status).toBe(202);
    expect(insertEvalArmMetrics).toHaveBeenCalledWith({
      workspaceId: WS,
      rows: [expect.objectContaining({ strata: [] })],
    });
  });

  it("400 on malformed row (missing required field)", async () => {
    const res = await POST(req({ run_id: "x", arm: "full" }));
    expect(res.status).toBe(400);
    expect(insertEvalArmMetrics).not.toHaveBeenCalled();
  });

  it("400 when a nullable field is a non-numeric, non-null value", async () => {
    const res = await POST(req({ ...valid, false_green_rate: "n/a" }));
    expect(res.status).toBe(400);
  });

  it("400 on batch exceeding 100 rows", async () => {
    const batch = Array.from({ length: 101 }, () => ({ ...valid }));
    const res = await POST(req(batch));
    expect(res.status).toBe(400);
  });

  it("502 when persistence throws", async () => {
    vi.mocked(insertEvalArmMetrics).mockRejectedValue(new Error("db down"));
    const res = await POST(req(valid));
    expect(res.status).toBe(502);
  });
});
