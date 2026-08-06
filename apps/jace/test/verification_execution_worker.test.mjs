import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVerificationExecutionWorkerId,
  createClaimFn,
  createCompleteFn,
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

test("routes UI/API claims only to mechanical executors and never constructs an Eve client", async () => {
  const calls = { browser: [], api: [] };
  const routed = createRoutedExecuteFn({
    browserExecute: async (item) => { calls.browser.push(item); return { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "sidecar unavailable" }; },
    apiExecute: async (item) => { calls.api.push(item); return { status: "not_testable", observedBehavior: null, artifactIds: [], reason: "api unavailable" }; },
  });
  const ui = { previewUrl: "https://preview", execution: { id: "ui" }, plan: { modality: "ui", uiSteps: [{ action: "open", path: "/" }] } };
  const api = { previewUrl: "https://preview", execution: { id: "api" }, workspaceId: "ws", plan: { modality: "api", recordId: "record", prRevisionId: "revision", criterionId: "criterion", flow: "GET", expectedBehavior: "200", apiRequest: { method: "GET", path: "/api/health", expectedStatus: 200 } } };

  assert.equal((await routed(ui)).reason, "sidecar unavailable");
  assert.equal((await routed(api)).reason, "api unavailable");
  assert.deepEqual(calls.browser, [ui]);
  assert.deepEqual(calls.api, [api]);
  assert.equal((await routed({ plan: {} })).status, "not_testable");
  assert.equal(calls.api.length, 1);
});
