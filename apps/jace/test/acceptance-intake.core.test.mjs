import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCEPTANCE_INTAKE_PATH,
  recordHostedAcceptanceIntake,
} from "../agent/lib/acceptance_intake.core.mjs";

const inbound = {
  channel: "slack",
  message: "Add a saved filter",
  sourceKey: "inbox-1",
  target: { channelId: "C1", conversationId: "thread-1" },
  auth: { attributes: { workspaceId: "workspace-1", conversationKey: "thread-1" } },
};

test("records a bound hosted message with its durable source key", async () => {
  let call;
  const result = await recordHostedAcceptanceIntake({
    inbound,
    env: { JACE_CONSOLE_BASE_URL: "https://console.test/", JACE_CONSOLE_TOKEN: "secret" },
    transport: async (url, init) => {
      call = { url, init };
      return { status: 201 };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(call.url, `https://console.test${ACCEPTANCE_INTAKE_PATH}`);
  const body = JSON.parse(call.init.body);
  assert.equal(body.workspaceId, "workspace-1");
  assert.equal(body.originChannel, "slack");
  assert.equal(body.conversationKey, "thread-1");
  assert.equal(body.sourceKey, "inbox-1");
});

test("fails closed for a bound message without a durable source key", async () => {
  const result = await recordHostedAcceptanceIntake({
    inbound: { ...inbound, sourceKey: undefined },
    env: { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "secret" },
    transport: async () => ({ status: 201 }),
  });
  assert.deepEqual(result, { ok: false, reason: "missing_source_key" });
});
