import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceIntakeMessagesPath, recordDeliveredAcceptanceReply, resolveBoundAcceptanceReply } from "../agent/lib/acceptance_intake_reply.core.mjs";

test("uses the current trusted workspace/intake binding and never caller input", async () => {
  let call;
  const result = await recordDeliveredAcceptanceReply({
    sessionAuth: { current: { attributes: { workspaceId: "workspace-current", acceptanceIntakeId: "intake/current" } }, initiator: { attributes: { workspaceId: "old", acceptanceIntakeId: "old" } } },
    sourceKey: "reply-1", text: "Which repository?", env: { JACE_CONSOLE_BASE_URL: "https://console.test/", JACE_CONSOLE_TOKEN: "secret" },
    transport: async (url, init) => { call = { url, init }; return { status: 201, json: async () => ({ inserted: true, message: { id: "message-1" } }) }; },
  });
  assert.equal(call.url, `https://console.test${acceptanceIntakeMessagesPath("intake/current")}`);
  assert.equal(call.init.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(call.init.body), { workspaceId: "workspace-current", sourceKey: "reply-1", text: "Which repository?", metadata: {} });
  assert.deepEqual(result, { ok: true, intakeId: "intake/current", messageId: "message-1", inserted: true });
});

test("returns structured degraded reasons and does not call transport without binding", async () => {
  const result = await recordDeliveredAcceptanceReply({ sessionAuth: { current: { attributes: { workspaceId: "workspace-1" } } }, sourceKey: "reply-1", text: "Question", transport: async () => assert.fail("must not call") });
  assert.deepEqual(result, { ok: false, degraded: true, reason: "missing_intake_binding" });
  assert.deepEqual(resolveBoundAcceptanceReply(null), { ok: false, reason: "missing_session_binding" });
});

test("degrades on transport/status/response failures without exposing the secret", async () => {
  const args = { sessionAuth: { current: { attributes: { workspaceId: "workspace-1", acceptanceIntakeId: "intake-1" } } }, sourceKey: "reply-1", text: "Question", env: { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "super-secret" } };
  assert.deepEqual(await recordDeliveredAcceptanceReply({ ...args, transport: async () => { throw new Error("super-secret"); } }), { ok: false, degraded: true, reason: "console_unreachable" });
  assert.deepEqual(await recordDeliveredAcceptanceReply({ ...args, transport: async () => ({ status: 404, json: async () => ({}) }) }), { ok: false, degraded: true, reason: "intake_not_found", status: 404 });
  assert.deepEqual(await recordDeliveredAcceptanceReply({ ...args, transport: async () => ({ status: 201, json: async () => ({}) }) }), { ok: false, degraded: true, reason: "console_invalid_response", status: 201 });
});
