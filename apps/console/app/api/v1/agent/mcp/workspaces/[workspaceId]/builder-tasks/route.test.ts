import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceBuilderTask: vi.fn(), recordAcceptanceContextPackDelivery: vi.fn() }));
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { readAcceptanceBuilderTask, recordAcceptanceContextPackDelivery } from "@agentrail/db-postgres";
import { GET } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
function request(query = "?builder=Codex&taskContextKey=task-1") {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/builder-tasks${query}`);
}
const params = Promise.resolve({ workspaceId: WS });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "key-1", workspaceId: WS } as never);
  vi.mocked(readAcceptanceBuilderTask).mockResolvedValue({
    handoff: { id: "handoff-1", recordId: "record-1", workspaceId: WS, repositoryId: "repo-1", builder: "codex", taskContextKey: "task-1", branchName: "jace/save", status: "handed_off", createdAt: new Date("2026-08-06T00:00:00.000Z"), prAttachedAt: null },
    record: { id: "record-1", repo: "acme/widgets", originChannel: "slack", sourceReferences: [{ kind: "slack_thread", id: "t-1" }] },
    contract: { id: "contract-1", version: 2, status: "confirmed", contract: { goal: "Save" }, confirmedAt: new Date("2026-08-06T00:01:00.000Z") },
    contextPack: { id: "pack-1", version: 3, phase: "execute", contentHash: "sha256:abc", compilerVersion: "1", manifest: { tokenBudget: 100 }, custody: { fullSourceUploadAllowed: false }, freshness: { indexRevision: "1", repositoryRef: "main" }, jsonArtifactRef: "artifact.json", markdownArtifactRef: "artifact.md" },
    repositoryRef: "main",
  } as never);
  vi.mocked(recordAcceptanceContextPackDelivery).mockResolvedValue({
    delivery: { id: "delivery-1", method: "mcp", deliveredAt: new Date("2026-08-06T00:02:00.000Z") },
    inserted: true,
  } as never);
});

describe("MCP builder task handoff", () => {
  it("requires acceptance read scope", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }) as never);
    expect((await GET(request(), { params })).status).toBe(403);
    expect(readAcceptanceBuilderTask).not.toHaveBeenCalled();
    expect(recordAcceptanceContextPackDelivery).not.toHaveBeenCalled();
  });

  it("rejects missing exact task identity", async () => {
    const response = await GET(request("?builder=codex"), { params });
    expect(response.status).toBe(400);
    expect(readAcceptanceBuilderTask).not.toHaveBeenCalled();
    expect(recordAcceptanceContextPackDelivery).not.toHaveBeenCalled();
  });

  it("fails closed when the recorded task does not resolve", async () => {
    vi.mocked(readAcceptanceBuilderTask).mockResolvedValue(null);
    expect((await GET(request(), { params })).status).toBe(404);
    expect(readAcceptanceBuilderTask).toHaveBeenCalledWith({ workspaceId: WS, builder: "codex", taskContextKey: "task-1" });
    expect(recordAcceptanceContextPackDelivery).not.toHaveBeenCalled();
  });

  it("records the authenticated MCP delivery before returning only the selected contract and bounded pack", async () => {
    const response = await GET(request(), { params });
    expect(response.status).toBe(200);
    expect(recordAcceptanceContextPackDelivery).toHaveBeenCalledWith({
      workspaceId: WS, recordId: "record-1", contextPackId: "pack-1",
      deliveryKey: "mcp:key-1:handoff-1", method: "mcp", recipient: "codex:task-1",
      metadata: { handoffId: "handoff-1", agentMcpCredentialId: "key-1" },
      deliveredBy: "agent_mcp:key-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      handoff: { id: "handoff-1", builder: "codex", taskContextKey: "task-1" },
      record: { repo: "acme/widgets", originChannel: "slack" },
      confirmedContract: { id: "contract-1", version: 2, status: "confirmed" },
      contextPack: { id: "pack-1", version: 3, jsonArtifactRef: "artifact.json" },
      repositoryRef: "main",
      delivery: { id: "delivery-1", method: "mcp", inserted: true, deliveredAt: "2026-08-06T00:02:00.000Z" },
      note: expect.stringContaining("not proof"),
    });
  });

  it("fails closed rather than expose an unrecorded Builder Context Pack", async () => {
    vi.mocked(recordAcceptanceContextPackDelivery).mockRejectedValue(new Error("database unavailable"));
    const response = await GET(request(), { params });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Builder Context Pack delivery could not be recorded" });
  });
});
