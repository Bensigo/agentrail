import { defineChannel, POST } from "eve/channels";
import { resolveMcpSessionIdentity } from "../lib/mcp.core.mjs";
import { recordMcpAcceptanceReply } from "../lib/mcp_reply.core.mjs";

type McpState = {
  workspaceId: string;
  taskContextKey: string;
  mcpCredentialId: string;
  mcpInboundSourceKey: string;
};

export default defineChannel<McpState>({
  kindHint: "mcp",
  state: { workspaceId: "", taskContextKey: "", mcpCredentialId: "", mcpInboundSourceKey: "" },
  routes: [
    POST("/eve/v1/mcp-handoff", async () => new Response(null, { status: 404 })),
  ],
  async receive(input, { send }) {
    const identity = resolveMcpSessionIdentity(input);
    if (!identity.ok) throw new Error(`mcp.receive rejected (${identity.reason})`);
    return send(input.message, {
      auth: input.auth,
      continuationToken: identity.continuationToken,
      state: identity.state,
    });
  },
  events: {
    async "message.completed"(data, _channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      const recorded = await recordMcpAcceptanceReply({
        session: ctx?.session,
        text: data.message,
        env: process.env,
        transport: fetch,
      });
      if (!recorded.ok) {
        throw new Error(`MCP reply custody failed (${recorded.reason})`);
      }
    },
  },
});
