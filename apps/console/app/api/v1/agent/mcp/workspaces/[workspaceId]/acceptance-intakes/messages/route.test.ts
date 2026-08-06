import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/agent-mcp-auth", () => ({ requireAgentMcpWorkspace: vi.fn() }));
vi.mock("@/lib/agent-mcp-intake", () => ({
  MCP_TASK_CONTEXT_KEY_LIMIT: 256,
  MCP_USER_MESSAGE_LIMIT: 8_000,
  MCP_MESSAGE_KEY_LIMIT: 256,
  boundedText: (value: unknown, maxLength: number) => typeof value === "string" && value.trim() && value.trim().length <= maxLength ? value.trim() : null,
  mcpConversationKey: (apiKeyId: string, taskContextKey: string) => `mcp:${apiKeyId}:${taskContextKey}`,
  mcpInboundSourceKey: (apiKeyId: string, taskContextKey: string, messageKey: string) => `mcp-inbound:${apiKeyId}:${taskContextKey}:${messageKey}`,
  dispatchMcpAcceptanceTurn: vi.fn(),
}));
vi.mock("@agentrail/db-postgres", () => ({ acceptanceIntakeId: vi.fn(), readAcceptanceIntake: vi.fn() }));

import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";
import { dispatchMcpAcceptanceTurn } from "@/lib/agent-mcp-intake";
import { acceptanceIntakeId, readAcceptanceIntake } from "@agentrail/db-postgres";
import { POST } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
function params() { return Promise.resolve({ workspaceId: WS }); }
function post(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/agent/mcp/workspaces/${WS}/acceptance-intakes/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAgentMcpWorkspace).mockResolvedValue({ apiKeyId: "mcp-key", workspaceId: WS } as never);
  vi.mocked(acceptanceIntakeId).mockReturnValue("intake-1");
  vi.mocked(readAcceptanceIntake).mockResolvedValue({ messages: [] } as never);
  vi.mocked(dispatchMcpAcceptanceTurn).mockResolvedValue({ ok: true, sessionId: "session-1", continuationToken: "continuation-1" });
});

describe("MCP acceptance intake task-context reply", () => {
  it("forwards only an explicit, idempotent task-context message", async () => {
    const response = await POST(post({ taskContextKey: "codex-thread-1", userMessage: "Use acme/web", messageKey: "user-turn-2", contract: { fake: true } }), { params: params() });
    expect(response.status).toBe(202);
    expect(requireAgentMcpWorkspace).toHaveBeenCalledWith(expect.any(NextRequest), WS, "acceptance:intake:write");
    expect(dispatchMcpAcceptanceTurn).toHaveBeenCalledWith({
      workspaceId: WS, apiKeyId: "mcp-key", taskContextKey: "codex-thread-1", text: "Use acme/web",
      sourceKey: "mcp-inbound:mcp-key:codex-thread-1:reply:user-turn-2",
    });
  });

  it("does not invoke Jace again for the same recorded task-context message", async () => {
    vi.mocked(readAcceptanceIntake).mockResolvedValue({ messages: [{ sourceKey: "mcp-inbound:mcp-key:codex-thread-1:reply:user-turn-2", direction: "inbound", text: "Use acme/web" }] } as never);
    const response = await POST(post({ taskContextKey: "codex-thread-1", userMessage: "Use acme/web", messageKey: "user-turn-2" }), { params: params() });
    expect(response.status).toBe(200);
    expect(dispatchMcpAcceptanceTurn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ duplicate: true });
  });

  it("fails closed when the MCP workspace guard fails", async () => {
    vi.mocked(requireAgentMcpWorkspace).mockResolvedValue(new NextResponse(null, { status: 403 }) as never);
    const response = await POST(post({ taskContextKey: "codex-thread-1", userMessage: "Use acme/web", messageKey: "user-turn-2" }), { params: params() });
    expect(response.status).toBe(403);
    expect(readAcceptanceIntake).not.toHaveBeenCalled();
  });
});
