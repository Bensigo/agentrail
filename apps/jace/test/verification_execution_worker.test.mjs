import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVerificationExecutionWorkerId,
  createClaimFn,
  createCompleteFn,
  createExecuteFn,
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
