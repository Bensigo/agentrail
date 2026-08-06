import test from "node:test";
import assert from "node:assert/strict";

import { createVerificationExecutionConsole } from "../agent/lib/verification_execution_console.mjs";

const env = {
  JACE_CONSOLE_BASE_URL: "https://console.example",
  JACE_CONSOLE_TOKEN: "token",
};

test("claim and completion use only trust execution endpoints", async () => {
  const calls = [];
  const executionConsole = createVerificationExecutionConsole({
    env,
    transport: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const response = calls.length === 1
        ? { execution: { id: "execution" }, plan: {}, pr: {}, previewUrl: null }
        : { execution: { id: "execution", status: "not_testable" } };
      return { status: 200, json: async () => response };
    },
  });

  const item = await executionConsole.claim("worker");
  await executionConsole.complete({
    executionId: "execution",
    workerId: "worker",
    status: "not_testable",
    resultReason: "No preview",
  });

  assert.equal(item.workerId, "worker");
  assert.equal(calls[0].url, `${env.JACE_CONSOLE_BASE_URL}/api/v1/runner/evidence-verification-executions/claim`);
  assert.equal(calls[0].body.workerId, "worker");
  assert.equal(calls[1].url, `${env.JACE_CONSOLE_BASE_URL}/api/v1/runner/evidence-verification-executions/execution/complete`);
  assert.deepEqual(calls[1].body, {
    workerId: "worker",
    status: "not_testable",
    resultReason: "No preview",
  });
});

test("console failures are surfaced to the worker", async () => {
  const executionConsole = createVerificationExecutionConsole({
    env,
    transport: async () => ({ status: 409, json: async () => ({ error: "execution is not claimed by this worker" }) }),
  });

  await assert.rejects(
    () => executionConsole.claim("worker"),
    /execution is not claimed by this worker/,
  );
});
