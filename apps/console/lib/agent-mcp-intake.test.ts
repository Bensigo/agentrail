import { describe, expect, it } from "vitest";
import { dispatchMcpAcceptanceTurn, mcpConversationKey, mcpInboundSourceKey } from "./agent-mcp-intake";

describe("agent MCP intake dispatch", () => {
  it("derives credential-scoped conversation and source identities", () => {
    expect(mcpConversationKey("key-1", "task-1")).toBe("mcp:key-1:task-1");
    expect(mcpInboundSourceKey("key-1", "task-1", "reply:message-2")).toBe("mcp-inbound:key-1:task-1:reply:message-2");
  });

  it("posts only the virtual MCP channel shape", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await dispatchMcpAcceptanceTurn({
      workspaceId: "workspace-1", apiKeyId: "key-1", taskContextKey: "task-1", text: "Add save", sourceKey: "source-1",
      env: { JACE_HOSTED_INBOUND_URL: "https://eve.test/eve/v1/hosted-inbound" },
      transport: (async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ sessionId: "session-1", continuationToken: "continuation-1" }), { status: 200 });
      }) as typeof fetch,
    });
    expect(result).toEqual({ ok: true, sessionId: "session-1", continuationToken: "continuation-1" });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(expect.objectContaining({
      channel: "mcp", sourceKey: "source-1", target: { workspaceId: "workspace-1", taskContextKey: "task-1" },
      auth: expect.objectContaining({ principalId: "agent-mcp:key-1" }),
    }));
  });
});
