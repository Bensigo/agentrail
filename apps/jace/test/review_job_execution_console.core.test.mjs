import test from "node:test";
import assert from "node:assert/strict";
import { runReviewJobExecution } from "../agent/lib/review_job_execution_console.core.mjs";

const env = {
  JACE_CONSOLE_BASE_URL: "https://console.example.test",
  JACE_CONSOLE_TOKEN: "secret",
};
const input = {
  eveSessionId: "eve-1",
  jobId: "job/1",
  criterionId: "AC-JOB",
  previewBootId: "boot-1",
  keyring: {
    keys: new Map([
      ["current", Buffer.alloc(32, 1)],
      ["old", Buffer.alloc(32, 2)],
    ]),
  },
};
const request = {
  trigger: {
    method: "POST",
    path: "/__agentrail/verification/jobs/run-1/trigger",
    expectedStatus: 202,
  },
  readback: {
    method: "GET",
    path: "/__agentrail/verification/jobs/run-1/result",
    expectedStatus: 200,
    digestAlgorithm: "hmac-sha256-v1",
    digestKeyId: "old",
    digestContext: "a".repeat(64),
    expectedJson: [
      {
        pointer: "/ready",
        equalsType: "boolean",
        equalsHmacSha256: "b".repeat(64),
      },
    ],
  },
};
const context = {
  ok: true,
  executionId: "execution/1",
  jobId: input.jobId,
  criterionId: input.criterionId,
  expected: "Job ready.",
  previewBootId: input.previewBootId,
  previewUrl: "https://preview.example.test",
  jobRequest: request,
};
const receipt = {
  ok: true,
  state: "not_proven",
  expected: "Job ready.",
  observed: "x",
  observedTriggerStatus: 503,
  observedReadbackStatus: null,
  assertionCount: 1,
  evidenceRef: "review-job-execution:execution/1",
  evidenceKey: "key",
  evidenceUrl: "https://artifacts.example.test/signed",
};
const response = (status, json) => ({ status, json: async () => json });

test("job start is at most once, sends sorted retained ids, and completion sends exact mismatch fields", async () => {
  const calls = [];
  const result = await runReviewJobExecution({
    ...input,
    env,
    transport: async (_url, init) => {
      calls.push(init);
      return calls.length === 1
        ? response(201, context)
        : response(201, receipt);
    },
    execute: ({ context: item, completeExecution }) =>
      completeExecution({
        executionId: item.executionId,
        jobId: item.jobId,
        criterionId: item.criterionId,
        previewBootId: item.previewBootId,
        observedTriggerStatus: 503,
        observedReadbackStatus: null,
        observations: [],
      }),
  });
  assert.deepEqual(result, receipt);
  assert.deepEqual(JSON.parse(calls[0].body), {
    eveSessionId: "eve-1",
    criterionId: "AC-JOB",
    previewBootId: "boot-1",
    digestKeyIds: ["current", "old"],
  });
  assert.deepEqual(JSON.parse(calls[1].body), {
    eveSessionId: "eve-1",
    observedTriggerStatus: 503,
    observedReadbackStatus: null,
    observations: [],
  });
});

test("matching readback forwards only ordered typed HMAC observations and completion retries once", async () => {
  const observations = [
      {
        pointer: "/ready",
        found: true,
        observedType: "boolean",
        observedHmacSha256: "c".repeat(64),
      },
    ],
    calls = [];
  const result = await runReviewJobExecution({
    ...input,
    env,
    transport: async (_url, init) => {
      calls.push(init);
      return calls.length === 1
        ? response(201, context)
        : calls.length === 2
          ? response(503, {})
          : response(201, {
              ...receipt,
              observedTriggerStatus: 202,
              observedReadbackStatus: 200,
            });
    },
    execute: ({ context: item, completeExecution }) =>
      completeExecution({
        executionId: item.executionId,
        jobId: item.jobId,
        criterionId: item.criterionId,
        previewBootId: item.previewBootId,
        observedTriggerStatus: 202,
        observedReadbackStatus: 200,
        observations,
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[1].body).observations, observations);
});
