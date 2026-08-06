import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptanceIntakeConfirmPath, confirmAcceptanceContractFromBoundIntake } from "../agent/lib/acceptance_intake_confirm.core.mjs";

const env = { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "secret" };
const auth = { current: { attributes: { workspaceId: "workspace-1", acceptanceIntakeId: "intake-1", acceptanceInboundSourceKey: "message-2" } } };

test("confirms only with the current trusted inbound message binding", async () => {
  let seen;
  const result = await confirmAcceptanceContractFromBoundIntake({ sessionAuth: auth, version: 2, env, transport: async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return { status: 200, json: async () => ({ contract: { id: "contract-2", version: 2, status: "confirmed" } }) };
  } });
  assert.equal(seen.url, `${env.JACE_CONSOLE_BASE_URL}${acceptanceIntakeConfirmPath("intake-1")}`);
  assert.deepEqual(seen.body, { workspaceId: "workspace-1", version: 2, confirmationSourceKey: "message-2" });
  assert.deepEqual(result.contract, { id: "contract-2", version: 2, status: "confirmed" });
});

test("fails closed without a current inbound message binding", async () => {
  const result = await confirmAcceptanceContractFromBoundIntake({ sessionAuth: { current: { attributes: { workspaceId: "workspace-1", acceptanceIntakeId: "intake-1" } } }, version: 1, env, transport: async () => { throw new Error("must not call"); } });
  assert.equal(result.reason, "missing_confirmation_turn_binding");
});

test("the native tool accepts only the draft version; session auth supplies every identity", () => {
  const source = readFileSync(fileURLToPath(new URL("../agent/tools/confirm_acceptance_contract.ts", import.meta.url)), "utf8");
  const schema = source.match(/inputSchema:\s*z\.object\(\{([\s\S]*?)\}\),\n\s*async execute/);
  assert.ok(schema, "could not find the confirmation tool input schema");
  const fields = [...schema[1].matchAll(/(\w+):\s*z\./g)].map((match) => match[1]).sort();
  assert.deepEqual(fields, ["version"]);
  assert.match(source, /sessionAuth:\s*ctx\?\.session\?\.auth/);
});
