// Jace's virtual MCP hosted channel — the Console hands a credential-bound
// task turn here through `hosted-inbound.ts`, and this module keeps the turn
// inside the existing acceptance/session spine.
//
// The stub route below exists only so Eve registers a unique cross-channel
// receive fingerprint, even when the channel is imported from a bundled
// entry point. It is not a real inbound surface.
import { defineChannel, POST } from "eve/channels";
import { recordDeliveredChannelReply } from "../lib/acceptance_intake_reply.core.mjs";
import { resolveMcpSessionIdentity } from "../lib/mcp.core.mjs";

type MCPState = {
  workspaceId: string;
  taskContextKey: string;
  mcpCredentialId: string;
};

export default defineChannel<MCPState>({
  kindHint: "mcp",
  state: { workspaceId: "", taskContextKey: "", mcpCredentialId: "" },
  routes: [
    // Not a live inbound endpoint — it only gives Eve a unique route
    // fingerprint so cross-channel receive registration stays safe.
    POST("/eve/v1/mcp-handoff", async () => new Response(null, { status: 404 })),
  ],
  async receive(input, { send }) {
    const identity = resolveMcpSessionIdentity(input);
    if (!identity.ok) {
      throw new Error(
        "mcp.receive requires target.workspaceId, target.taskContextKey, and auth.attributes.mcpCredentialId.",
      );
    }

    return send(input.message, {
      auth: input.auth,
      continuationToken: identity.continuationToken,
      state: identity.state,
    });
  },
  events: {
    async "message.completed"(data, _channel, ctx) {
      if (data.finishReason === "tool-calls" || !data.message) return;
      await recordDeliveredChannelReply({
        session: ctx?.session,
        channel: "mcp",
        text: data.message,
        env: process.env,
        transport: fetch,
      });
    },
  },
});
