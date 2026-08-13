import assert from "node:assert/strict";
import { test } from "node:test";
import { recordMcpAcceptanceReply } from "../agent/lib/mcp_reply.core.mjs";

test("MCP reply custody derives workspace and Intake from the bound session", async () => {
  let request;
  const result = await recordMcpAcceptanceReply({
    session: {
      id: "session-1",
      turn: { id: "turn-1" },
      auth: { current: { attributes: {
        workspaceId: "workspace-1",
        acceptanceIntakeId: "intake-1",
      } } },
    },
    text: "Which repository should this plan target?",
    env: { JACE_CONSOLE_BASE_URL: "https://console.example", JACE_CONSOLE_TOKEN: "secret" },
    transport: async (url, init) => {
      request = { url, init };
      return { status: 201, json: async () => ({ message: { id: "message-1" } }) };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(request.url, "https://console.example/api/v1/runner/acceptance-intakes/intake-1/messages");
  assert.deepEqual(JSON.parse(request.init.body), {
    workspaceId: "workspace-1",
    sourceKey: "jace-mcp-reply:session-1:turn-1",
    text: "Which repository should this plan target?",
    metadata: { kind: "jace_mcp_reply", channel: "mcp" },
  });
});
