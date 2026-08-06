import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVerificationExecutionWorkerId,
  createClaimFn,
  createCompleteFn,
  createExecuteFn,
  createRoutedExecuteFn,
} from "../agent/lib/verification_execution_worker.mjs";

test("builds a process-specific verification worker identifier", () => {
  assert.equal(
    buildVerificationExecutionWorkerId({ hostnameFn: () => "host", pid: 42 }),
    "verification-worker-host-42",
  );
});

test("claims and completes through the isolated execution console", async () => {
  const calls = [];
  const executionConsole = {
    claim: async (workerId) => { calls.push(["claim", workerId]); return { execution: { id: "e" } }; },
    complete: async (input) => { calls.push(["complete", input]); },
  };
  const claim = createClaimFn({ workerId: "worker", executionConsole });
  const complete = createCompleteFn({ executionConsole });

  assert.deepEqual(await claim(), { execution: { id: "e" } });
  await complete({ executionId: "e", workerId: "worker", status: "not_testable" });
  assert.deepEqual(calls, [
    ["claim", "worker"],
    ["complete", { executionId: "e", workerId: "worker", status: "not_testable" }],
  ]);
});

test("requires a structured Eve result before completing a criterion", async () => {
  let seen;
  const execute = createExecuteFn({
    client: {
      session: () => ({
        send: async (input) => {
          seen = input;
          return { result: async () => ({ status: "waiting", data: { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "no preview" } }) };
        },
      }),
    },
  });

  const result = await execute("verify only this criterion");
  assert.equal(seen.message, "verify only this criterion");
  assert.equal(seen.outputSchema.type, "object");
  assert.equal(result.status, "not_testable");
});

test("refuses an Eve turn without structured data", async () => {
  const execute = createExecuteFn({
    client: { session: () => ({ send: async () => ({ result: async () => ({ status: "waiting" }) }) }) },
  });

  await assert.rejects(() => execute("verify"), /without structured evidence result/);
});

test("routes UI claims to the mechanical executor and keeps API on the existing constrained Eve prompt", async () => {
  const calls = { browser: [], eve: [] };
  const routed = createRoutedExecuteFn({
    browserExecute: async (item) => { calls.browser.push(item); return { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "sidecar unavailable" }; },
    client: { session: () => ({ send: async (input) => { calls.eve.push(input); return { result: async () => ({ status: "completed", data: { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "api unavailable" } }) }; } }) },
  });
  const ui = { previewUrl: "https://preview", execution: { id: "ui" }, plan: { modality: "ui", uiSteps: [{ action: "open", path: "/" }] } };
  const api = { previewUrl: "https://preview", execution: { id: "api" }, workspaceId: "ws", plan: { modality: "api", recordId: "record", prRevisionId: "revision", criterionId: "criterion", flow: "GET", expectedBehavior: "200", apiRequest: { method: "GET", path: "/api/health", expectedStatus: 200 } } };

  assert.equal((await routed(ui)).reason, "sidecar unavailable");
  assert.equal((await routed(api)).reason, "api unavailable");
  assert.deepEqual(calls.browser, [ui]);
  assert.equal(calls.eve.length, 1);
  assert.match(calls.eve[0].message, /Dispatch qa to fetch only GET/);
  assert.equal((await routed({ plan: {} })).status, "not_testable");
  assert.equal(calls.eve.length, 1);
});
