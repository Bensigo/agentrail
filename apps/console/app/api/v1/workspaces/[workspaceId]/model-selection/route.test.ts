import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  getModelOutcomeStats: vi.fn(),
}));

import { GET } from "./route";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getModelOutcomeStats } from "@agentrail/db-postgres";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/workspaces/${WS}/model-selection`, {
    method: "GET",
  });
}
function params() {
  return Promise.resolve({ workspaceId: WS });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ id: "m1" } as never);
  vi.mocked(getModelOutcomeStats).mockResolvedValue([]);
});

describe("GET /api/v1/workspaces/[workspaceId]/model-selection", () => {
  it("401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(401);
  });

  it("403 when not a workspace member", async () => {
    vi.mocked(getWorkspaceMembership).mockResolvedValue(null as never);
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(403);
  });

  it("scopes the stats query to this workspace", async () => {
    await GET(req(), { params: params() });
    expect(getModelOutcomeStats).toHaveBeenCalledWith({ workspaceId: WS });
  });

  it("reports learningEnabled false when neither flag env var is set (AC: default-off)", async () => {
    const res = await GET(req(), { params: params() });
    const body = await res.json();
    expect(body.learningEnabled).toBe(false);
  });

  it("returns one entry per task type, seed-flagged, mechanical's untried models at zero stats", async () => {
    const res = await GET(req(), { params: params() });
    const body = await res.json();

    expect(body.taskTypes.map((t: { taskType: string }) => t.taskType)).toEqual([
      "ui",
      "refactor",
      "mechanical",
      "general",
    ]);

    const mechanical = body.taskTypes.find((t: { taskType: string }) => t.taskType === "mechanical");
    expect(mechanical.seedModel).toBe("z-ai/glm-4.7");
    expect(mechanical.models.map((m: { model: string }) => m.model)).toEqual(
      expect.arrayContaining([
        "z-ai/glm-4.7",
        "z-ai/glm-5.2",
        "deepseek/deepseek-v4-pro",
        "qwen/qwen3-coder-plus",
        "anthropic/claude-haiku-4.5",
      ])
    );
    for (const m of mechanical.models) {
      expect(m.runCount).toBe(0);
      expect(m.qualified).toBe(false);
      expect(m.costPerSuccess).toBeNull();
      expect(m.isSeed).toBe(m.model === "z-ai/glm-4.7");
    }
  });

  it("ui excludes haiku even with recorded (ineligible) outcomes for it", async () => {
    vi.mocked(getModelOutcomeStats).mockResolvedValue([
      {
        taskType: "ui",
        executeModel: "anthropic/claude-haiku-4.5",
        runCount: 20,
        successCount: 20,
        successRate: 1,
        avgCostUsd: 0.01,
        costPerSuccess: 0.01,
      },
    ]);
    const res = await GET(req(), { params: params() });
    const body = await res.json();
    const ui = body.taskTypes.find((t: { taskType: string }) => t.taskType === "ui");
    expect(ui.models.some((m: { model: string }) => m.model === "anthropic/claude-haiku-4.5")).toBe(
      false
    );
  });

  it("ranks a qualified, better success-rate model above the seed", async () => {
    vi.mocked(getModelOutcomeStats).mockResolvedValue([
      {
        taskType: "mechanical",
        executeModel: "z-ai/glm-4.7",
        runCount: 10,
        successCount: 5,
        successRate: 0.5,
        avgCostUsd: 0.02,
        costPerSuccess: 0.04,
      },
      {
        taskType: "mechanical",
        executeModel: "z-ai/glm-5.2",
        runCount: 10,
        successCount: 9,
        successRate: 0.9,
        avgCostUsd: 0.03,
        costPerSuccess: 0.033,
      },
    ]);
    const res = await GET(req(), { params: params() });
    const body = await res.json();
    const mechanical = body.taskTypes.find((t: { taskType: string }) => t.taskType === "mechanical");
    expect(mechanical.models[0].model).toBe("z-ai/glm-5.2");
    expect(mechanical.models[0].qualified).toBe(true);
  });
});
