import { describe, expect, it, vi } from "vitest";
import { dispatchMcpJaceTurn, mcpConversationKey } from "./agent-jace-mcp";

describe("Jace MCP hosted dispatch", () => {
  it("binds tenant and task identity server-side and forwards no Record authority", async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        sessionId: "session-1",
        continuationToken: "continuation-1",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(dispatchMcpJaceTurn({
      workspaceId: "workspace-1",
      credentialId: "credential-1",
      taskContextKey: "task-1",
      sourceKey: "source-1",
      message: "Plan this.",
      env: { JACE_HOSTED_INBOUND_URL: "http://jace.internal/eve/v1/hosted-inbound" },
      transport,
    })).resolves.toEqual({
      ok: true,
      sessionId: "session-1",
      continuationToken: "continuation-1",
    });
    const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      channel: "mcp",
      message: "Plan this.",
      sourceKey: "source-1",
      target: { workspaceId: "workspace-1", taskContextKey: "task-1" },
      auth: {
        authenticator: "agentrail",
        principalType: "agent_mcp",
        principalId: "agent-mcp:credential-1",
        attributes: {
          workspaceId: "workspace-1",
          channel: "mcp",
          conversationKey: mcpConversationKey("credential-1", "task-1"),
          mcpCredentialId: "credential-1",
        },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/recordId|contractId|merge|deploy/u);
  });
});
