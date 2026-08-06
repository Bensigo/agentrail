import test from "node:test";
import assert from "node:assert/strict";
import { requestAcceptanceContextPackFromBoundIntake } from "../agent/lib/acceptance_intake_context_pack.core.mjs";

const env = { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "secret" };
const auth = { current: { attributes: { workspaceId: "workspace-1", acceptanceIntakeId: "intake-1" } } };

test("admits only the session-bound intake and does not claim a pack was compiled", async () => {
  let seen;
  const result = await requestAcceptanceContextPackFromBoundIntake({ sessionAuth: auth, env, transport: async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return { status: 201, json: async () => ({ compilation: { id: "job-1", status: "queued", phase: "execute" }, inserted: true }) };
  } });
  assert.equal(seen.url, "https://console.test/api/v1/runner/acceptance-intakes/intake-1/context-pack-compilations");
  assert.deepEqual(seen.body, { workspaceId: "workspace-1" });
  assert.equal(result.compilation.status, "queued");
  assert.match(result.note, /do not claim a pack exists/);
});

test("fails closed when the contract is not confirmed", async () => {
  const result = await requestAcceptanceContextPackFromBoundIntake({ sessionAuth: auth, env, transport: async () => ({ status: 409, json: async () => ({}) }) });
  assert.deepEqual(result, { ok: false, degraded: true, reason: "contract_not_confirmed", status: 409 });
});
