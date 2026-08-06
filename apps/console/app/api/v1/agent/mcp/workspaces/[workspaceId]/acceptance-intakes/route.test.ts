import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({ recordAcceptanceInboundIntake: vi.fn() }));

import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { recordAcceptanceInboundIntake } from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
function params() { return Promise.resolve({ workspaceId: WS }); }
function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/acceptance-intakes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(recordAcceptanceInboundIntake).mockResolvedValue({
    intake: { id: "intake-1", status: "collecting_context" },
    message: { id: "message-1", sourceKey: "mcp-initial:mcp-key:codex-thread-1" },
    inserted: true,
  } as never);
});

describe("MCP acceptance intake start", () => {
  it("records raw task provenance with server-derived MCP channel identity only", async () => {
    const response = await POST(post({
      taskContextKey: "codex-thread-1", userTask: "Add a save button",
      repo: "attacker/selected-repo", originChannel: "slack", contract: { goal: "bypass confirmation" },
    }), { params: params() });

    expect(response.status).toBe(201);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:intake:write");
    expect(recordAcceptanceInboundIntake).toHaveBeenCalledWith({
      workspaceId: WS,
      originChannel: "mcp",
      conversationKey: "mcp:mcp-key:codex-thread-1",
      sourceKey: "mcp-initial:mcp-key:codex-thread-1",
      text: "Add a save button",
      sourceReferences: [{ kind: "agent_mcp_task", credentialId: "mcp-key", taskContextKey: "codex-thread-1" }],
      metadata: { ingress: "agent_mcp", credentialId: "mcp-key", taskContextKey: "codex-thread-1" },
    });
    await expect(response.json()).resolves.toMatchObject({
      intake: { id: "intake-1", status: "collecting_context" },
      nextStep: expect.stringContaining("human confirmation"),
    });
  });

  it("rejects incomplete input before recording an Intake", async () => {
    const response = await POST(post({ taskContextKey: "", userTask: "" }), { params: params() });
    expect(response.status).toBe(400);
    expect(recordAcceptanceInboundIntake).not.toHaveBeenCalled();
  });

  it("does not write after a failed workspace-bound MCP guard", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await POST(post({ taskContextKey: "codex-thread-1", userTask: "Add save" }), { params: params() });
    expect(response.status).toBe(403);
    expect(recordAcceptanceInboundIntake).not.toHaveBeenCalled();
  });
});
