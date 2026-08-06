import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ readAcceptanceBuilderTask: vi.fn() }));
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { readAcceptanceBuilderTask } from "@agentrail/db-postgres";
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
    contextPack: { id: "pack-1", version: 3, phase: "execute", contentHash: "sha256:abc", compilerVersion: "1", manifest: { tokenBudget: 100 }, custody: { fullSourceUploadAllowed: false }, freshness: { indexRevision: "1" }, jsonArtifactRef: "artifact.json", markdownArtifactRef: "artifact.md" },
  } as never);
});

describe("MCP builder task handoff", () => {
  it("requires acceptance read scope", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }) as never);
    expect((await GET(request(), { params })).status).toBe(403);
    expect(readAcceptanceBuilderTask).not.toHaveBeenCalled();
  });

  it("rejects missing exact task identity", async () => {
    const response = await GET(request("?builder=codex"), { params });
    expect(response.status).toBe(400);
    expect(readAcceptanceBuilderTask).not.toHaveBeenCalled();
  });

  it("fails closed when the recorded task does not resolve", async () => {
    vi.mocked(readAcceptanceBuilderTask).mockResolvedValue(null);
    expect((await GET(request(), { params })).status).toBe(404);
    expect(readAcceptanceBuilderTask).toHaveBeenCalledWith({ workspaceId: WS, builder: "codex", taskContextKey: "task-1" });
  });

  it("returns only the selected confirmed contract and bounded pack references", async () => {
    const response = await GET(request(), { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      handoff: { id: "handoff-1", builder: "codex", taskContextKey: "task-1" },
      record: { repo: "acme/widgets", originChannel: "slack" },
      confirmedContract: { id: "contract-1", version: 2, status: "confirmed" },
      contextPack: { id: "pack-1", version: 3, jsonArtifactRef: "artifact.json" },
      note: expect.stringContaining("not proof"),
    });
  });
});
