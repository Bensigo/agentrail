import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptanceIntakeDraftPath,
  draftAcceptanceContractFromBoundIntake,
  resolveBoundAcceptanceIntake,
} from "../agent/lib/acceptance_intake_draft.core.mjs";

const contract = {
  originalRequest: "Add a save button",
  normalizedRequirements: ["A user can save the form"],
  acceptanceCriteria: [{ id: "save", text: "Submitting persists the form", required: true, userVisible: true }],
  nonGoals: [], risks: [], stops: [], unresolvedQuestions: [], environment: {},
};

test("uses the current trusted session binding, not a caller-selected tenant or intake", async () => {
  let call;
  const result = await draftAcceptanceContractFromBoundIntake({
    sessionAuth: {
      current: { attributes: { workspaceId: "workspace-current", acceptanceIntakeId: "intake/current" } },
      initiator: { attributes: { workspaceId: "workspace-old", acceptanceIntakeId: "intake-old" } },
    },
    repo: "acme/web", contract,
    env: { JACE_CONSOLE_BASE_URL: "https://console.test/", JACE_CONSOLE_TOKEN: "secret" },
    transport: async (url, init) => {
      call = { url, init };
      return { status: 201, json: async () => ({ record: { id: "record-1", repo: "acme/web" }, contract: { id: "contract-1", version: 1, status: "draft" } }) };
    },
  });
  assert.equal(call.url, `https://console.test${acceptanceIntakeDraftPath("intake/current")}`);
  assert.equal(call.init.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(call.init.body), { workspaceId: "workspace-current", repo: "acme/web", contract });
  assert.equal(result.ok, true);
  assert.equal(result.intakeId, "intake/current");
  assert.equal(result.record.id, "record-1");
  assert.match(result.note, /human confirmation/);
});

test("fails closed when the session has no accepted intake binding", async () => {
  const result = await draftAcceptanceContractFromBoundIntake({
    sessionAuth: { current: { attributes: { workspaceId: "workspace-1" } } },
    repo: "acme/web", contract, env: {}, transport: async () => assert.fail("must not call transport"),
  });
  assert.deepEqual(result, { ok: false, degraded: true, reason: "missing_intake_binding" });
  assert.deepEqual(resolveBoundAcceptanceIntake(null), { ok: false, reason: "missing_session_binding" });
});

test("returns an honest degraded result when the intake is already linked", async () => {
  const result = await draftAcceptanceContractFromBoundIntake({
    sessionAuth: { initiator: { attributes: { workspaceId: "workspace-1", acceptanceIntakeId: "intake-1" } } },
    repo: "acme/web", contract,
    env: { JACE_CONSOLE_BASE_URL: "https://console.test", JACE_CONSOLE_TOKEN: "secret" },
    transport: async () => ({ status: 409, json: async () => ({}) }),
  });
  assert.deepEqual(result, { ok: false, degraded: true, reason: "intake_already_linked", status: 409 });
});

test("the native tool accepts only the repository and contract, while session auth supplies tenant and intake", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../agent/tools/draft_acceptance_contract.ts", import.meta.url)),
    "utf8",
  );
  const schema = source.match(/inputSchema:\s*z\.object\(\{([\s\S]*?)\n\s*\}\),\n\s*async execute/);
  assert.ok(schema, "could not find the draft tool input schema");
  const fields = [...schema[1].matchAll(/^\s{4}(\w+):\s*(?:z|contractSchema)\b/gm)].map((match) => match[1]).sort();
  assert.deepEqual(fields, ["contract", "repo"]);
  assert.match(source, /sessionAuth:\s*ctx\?\.session\?\.auth/);
});
