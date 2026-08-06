import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptanceIntakeReadbackPath,
  fetchAcceptanceIntake,
} from "../agent/lib/acceptance_intake_readback.core.mjs";

test("derives both tenant and intake from the current trusted session and returns compact evidence", async () => {
  let call;
  const result = await fetchAcceptanceIntake({
    sessionAuth: { current: { attributes: { workspaceId: "workspace-current", acceptanceIntakeId: "intake/current" } }, initiator: { attributes: { workspaceId: "old", acceptanceIntakeId: "old" } } },
    env: { JACE_CONSOLE_BASE_URL: "https://console.test/", JACE_CONSOLE_TOKEN: "secret" },
    transport: async (url, init) => { call = { url, init }; return { status: 200, json: async () => ({ readback: { intake: { status: "collecting_context" }, messageCounts: { total: 10, included: 9, truncated: true } } }) }; },
  });
  assert.equal(call.url, `https://console.test${acceptanceIntakeReadbackPath({ workspaceId: "workspace-current", intakeId: "intake/current" })}`);
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.Authorization, "Bearer secret");
  assert.equal(result.ok, true);
  assert.equal(result.readback.messageCounts.truncated, true);
});

test("fails closed without a session binding and never calls the transport", async () => {
  const result = await fetchAcceptanceIntake({ sessionAuth: { current: { attributes: { workspaceId: "workspace-1" } } }, env: {}, transport: async () => assert.fail("must not call transport") });
  assert.deepEqual(result, { ok: false, degraded: true, reason: "missing_intake_binding" });
});

test("does not accept model-supplied targeting and is read-only by policy", () => {
  const source = readFileSync(fileURLToPath(new URL("../agent/tools/fetch_acceptance_intake.ts", import.meta.url)), "utf8");
  assert.match(source, /inputSchema:\s*z\.object\(\{\}\)/);
  assert.match(source, /sessionAuth:\s*ctx\?\.session\?\.auth/);
  assert.doesNotMatch(source, /workspaceId:\s*input|intakeId:\s*input|method:\s*["']POST|createDraft/);
});

test("returns structured degraded status for a missing Intake", async () => {
  const result = await fetchAcceptanceIntake({ sessionAuth: { initiator: { attributes: { workspaceId: "workspace-1", acceptanceIntakeId: "intake-1" } } }, env: { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "secret" }, transport: async () => ({ status: 404, json: async () => ({}) }) });
  assert.deepEqual(result, { ok: false, degraded: true, reason: "intake_not_found", status: 404 });
});
