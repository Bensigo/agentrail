import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({ readEvidenceReviewCorrectionDeliveriesForTask: vi.fn() }));
vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));

import { readEvidenceReviewCorrectionDeliveriesForTask } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { GET } from "./route";

const WS = "ws-1";
const request = (query = "") => new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/correction-deliveries${query}`);
const params = Promise.resolve({ workspaceId: WS });

describe("MCP correction-delivery inbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the targeted task's evidence-bound packet and exact review revision", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ workspaceId: WS } as never);
    vi.mocked(readEvidenceReviewCorrectionDeliveriesForTask).mockResolvedValue([{
      delivery: { id: "delivery", channel: "mcp_task_context", target: { builder: "codex", taskContextKey: "task" }, attempt: 1, outcome: "queued", outcomeDetail: null, attemptedAt: new Date("2026-08-06T00:00:00Z"), confirmedAt: null },
      correction: { id: "correction", criterionId: "saved", expectedBehavior: "saved", observedBehavior: "missing", evidenceRefs: [], reproductionSteps: ["save"], likelyAffectedUnits: ["app.ts:9"], contextRefs: [], scopeBoundary: "contract", concreteImpact: "data loss", requiredCorrection: "persist", reverification: "save", repairPath: null },
      review: { id: "review" }, revision: { id: "revision", headSha: "abc" }, pr: { repositoryFullName: "org/repo", prNumber: 3 },
    }] as never);

    const response = await GET(request("?builder=codex&taskContextKey=task"), { params });
    expect(response.status).toBe(200);
    expect(readEvidenceReviewCorrectionDeliveriesForTask).toHaveBeenCalledWith({ workspaceId: WS, builder: "codex", taskContextKey: "task" });
    await expect(response.json()).resolves.toMatchObject({
      deliveries: [{ delivery: { id: "delivery", outcome: "queued", confirmedAt: null }, reviewRevision: { id: "revision", repository: "org/repo", prNumber: 3, headSha: "abc" }, packet: { correctionId: "correction", criterionId: "saved", requiredCorrection: "persist" } }],
    });
  });

  it("requires the recorded builder task coordinates", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ workspaceId: WS } as never);
    const response = await GET(request("?builder=codex"), { params });
    expect(response.status).toBe(400);
    expect(readEvidenceReviewCorrectionDeliveriesForTask).not.toHaveBeenCalled();
  });
});
