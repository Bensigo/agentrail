import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCEPTANCE_INTAKE_PATH, recordHostedAcceptanceIntake } from "../agent/lib/acceptance_intake.core.mjs";

const inbound = {
  channel: "slack", message: "Add a save button", sourceKey: "inbox-1",
  target: { channelId: "C1", conversationId: "thread-1" },
  auth: { attributes: { workspaceId: "workspace-1", conversationKey: "thread-1" } },
};

test("records a bound hosted message with its durable source key", async () => {
  let call;
  const result = await recordHostedAcceptanceIntake({ inbound, env: { JACE_CONSOLE_BASE_URL: "https://console.test/", JACE_CONSOLE_TOKEN: "secret" }, transport: async (url, init) => {
    call = { url, init }; return { status: 201, json: async () => ({ intake: { id: "intake-1" } }) };
  } });
  assert.deepEqual(result, { ok: true, intakeId: "intake-1" });
  assert.equal(call.url, `https://console.test${ACCEPTANCE_INTAKE_PATH}`);
  assert.equal(call.init.headers.Authorization, "Bearer secret");
  const body = JSON.parse(call.init.body);
  assert.equal(body.workspaceId, "workspace-1");
  assert.equal(body.originChannel, "slack");
  assert.equal(body.conversationKey, "thread-1");
  assert.equal(body.sourceKey, "inbox-1");
});

test("fails closed for a bound message without a durable source key", async () => {
  const result = await recordHostedAcceptanceIntake({ inbound: { ...inbound, sourceKey: undefined }, env: { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "secret" }, transport: async () => ({ status: 201, json: async () => ({}) }) });
  assert.deepEqual(result, { ok: false, reason: "missing_source_key" });
});

test("records an mcp intake with trusted credential/task-context metadata and never uses model input for those fields", async () => {
  let call;
  const result = await recordHostedAcceptanceIntake({
    inbound: {
      channel: "mcp",
      message: "Run the bound MCP task",
      sourceKey: "inbox-mcp-1",
      target: {
        workspaceId: "workspace-1",
        taskContextKey: "task-context-1",
        mcpCredentialId: "model-supplied-should-not-win",
      },
      auth: {
        attributes: {
          workspaceId: "workspace-1",
          mcpCredentialId: "trusted-credential-1",
        },
      },
    },
    env: { JACE_CONSOLE_BASE_URL: "https://console.test/", JACE_CONSOLE_TOKEN: "secret" },
    transport: async (url, init) => {
      call = { url, init };
      return { status: 201, json: async () => ({ intake: { id: "intake-mcp-1" } }) };
    },
  });

  assert.deepEqual(result, { ok: true, intakeId: "intake-mcp-1" });
  const body = JSON.parse(call.init.body);
  assert.equal(body.originChannel, "mcp");
  assert.equal(body.conversationKey, "mcp:trusted-credential-1:task-context-1");
  assert.equal(body.sourceReferences[0].kind, "agent_mcp_task");
  assert.equal(body.sourceReferences[0].conversationKey, "mcp:trusted-credential-1:task-context-1");
  assert.equal(body.sourceReferences[0].mcpCredentialId, "trusted-credential-1");
  assert.equal(body.sourceReferences[0].taskContextKey, "task-context-1");
  assert.equal(body.metadata.mcpCredentialId, "trusted-credential-1");
  assert.equal(body.metadata.taskContextKey, "task-context-1");
  assert.equal(body.sourceReferences[0].mcpCredentialId, body.metadata.mcpCredentialId);
  assert.equal(body.metadata.target.taskContextKey, "task-context-1");
  assert.equal(body.metadata.target.mcpCredentialId, "model-supplied-should-not-win");
});
