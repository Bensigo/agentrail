import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@/lib/agent-mcp-intake", () => ({
  MCP_TASK_CONTEXT_KEY_LIMIT: 256,
  MCP_USER_MESSAGE_LIMIT: 8_000,
  boundedText: (value: unknown, maxLength: number) => typeof value === "string" && value.trim() && value.trim().length <= maxLength ? value.trim() : null,
  mcpConversationKey: (apiKeyId: string, taskContextKey: string) => `mcp:${apiKeyId}:${taskContextKey}`,
  mcpInboundSourceKey: (apiKeyId: string, taskContextKey: string, messageKey: string) => `mcp-inbound:${apiKeyId}:${taskContextKey}:${messageKey}`,
  dispatchMcpAcceptanceTurn: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({ acceptanceIntakeId: vi.fn(), readAcceptanceIntake: vi.fn(), readAcceptanceIntakeReadback: vi.fn() }));

import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { dispatchMcpAcceptanceTurn } from "@/lib/agent-mcp-intake";
import { acceptanceIntakeId, readAcceptanceIntake, readAcceptanceIntakeReadback } from "@agentrail/db-postgres";
import { GET, POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
function params() { return Promise.resolve({ workspaceId: WS }); }
function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/acceptance-intakes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function get(taskContextKey = "codex-thread-1") {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/acceptance-intakes?taskContextKey=${encodeURIComponent(taskContextKey)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(acceptanceIntakeId).mockReturnValue("intake-1");
  vi.mocked(readAcceptanceIntake).mockResolvedValue({ messages: [] } as never);
  vi.mocked(dispatchMcpAcceptanceTurn).mockResolvedValue({ ok: true, sessionId: "session-1", continuationToken: "continuation-1" });
  vi.mocked(readAcceptanceIntakeReadback).mockResolvedValue({ intake: { id: "intake-1", status: "collecting_context" } } as never);
});

describe("MCP acceptance intake start and bounded readback", () => {
  it("forwards only server-derived MCP task identity into Jace", async () => {
    const response = await POST(post({
      taskContextKey: "codex-thread-1", userTask: "Add a save button",
      repo: "attacker/selected-repo", originChannel: "slack", contract: { goal: "bypass confirmation" },
    }), { params: params() });

    expect(response.status).toBe(202);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:intake:write");
    expect(dispatchMcpAcceptanceTurn).toHaveBeenCalledWith({
      workspaceId: WS, apiKeyId: "mcp-key", taskContextKey: "codex-thread-1", text: "Add a save button",
      sourceKey: "mcp-inbound:mcp-key:codex-thread-1:initial",
    });
    expect(acceptanceIntakeId).toHaveBeenCalledWith({ workspaceId: WS, originChannel: "mcp", conversationKey: "mcp:mcp-key:codex-thread-1" });
    await expect(response.json()).resolves.toMatchObject({ intake: { id: "intake-1" }, session: { id: "session-1" } });
  });

  it("rejects incomplete input before forwarding to Jace", async () => {
    const response = await POST(post({ taskContextKey: "", userTask: "" }), { params: params() });
    expect(response.status).toBe(400);
    expect(dispatchMcpAcceptanceTurn).not.toHaveBeenCalled();
  });

  it("does not forward after a failed workspace-bound MCP guard", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await POST(post({ taskContextKey: "codex-thread-1", userTask: "Add save" }), { params: params() });
    expect(response.status).toBe(403);
    expect(dispatchMcpAcceptanceTurn).not.toHaveBeenCalled();
  });

  it("does not invoke Jace again for a duplicate initial message", async () => {
    vi.mocked(readAcceptanceIntake).mockResolvedValue({ messages: [{ sourceKey: "mcp-inbound:mcp-key:codex-thread-1:initial", direction: "inbound", text: "Add a save button" }] } as never);
    const response = await POST(post({ taskContextKey: "codex-thread-1", userTask: "Add a save button" }), { params: params() });
    expect(response.status).toBe(200);
    expect(dispatchMcpAcceptanceTurn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ duplicate: true });
  });

  it("returns bounded readback only for the credential-derived intake", async () => {
    const response = await GET(get(), { params: params() });
    expect(response.status).toBe(200);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:read");
    expect(readAcceptanceIntakeReadback).toHaveBeenCalledWith({ workspaceId: WS, intakeId: "intake-1" });
    await expect(response.json()).resolves.toMatchObject({ note: expect.stringContaining("not a raw transcript") });
  });
});
