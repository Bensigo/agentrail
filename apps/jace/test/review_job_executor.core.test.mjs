import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createReviewJobExecutor } from "../agent/lib/review_job_executor.core.mjs";

const key = Buffer.alloc(32, 7),
  digestContext = "a".repeat(64);
const expectedDigest = (pointer, value) =>
  createHmac("sha256", key)
    .update(
      JSON.stringify([
        "agentrail.review-job.scalar.v1",
        digestContext,
        pointer,
        value === null ? "null" : typeof value,
        value,
      ]),
    )
    .digest("hex");
const context = {
  executionId: "job-execution-1",
  jobId: "job-1",
  criterionId: "criterion-1",
  expected: "Job is ready.",
  previewBootId: "boot-1",
  previewUrl: "https://preview.example.test/",
  jobRequest: {
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
      digestKeyId: "key-1",
      digestContext,
      expectedJson: [
        {
          pointer: "/ready",
          equalsType: "boolean",
          equalsHmacSha256: expectedDigest("/ready", true),
        },
      ],
    },
  },
};
const keyring = { keys: new Map([["key-1", key]]) };
function body(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let seen = false;
  return {
    getReader: () => ({
      read: async () =>
        seen ? { done: true } : ((seen = true), { done: false, value: bytes }),
      cancel: async () => {},
    }),
  };
}
function jsonResponse(value, status = 200) {
  return {
    status,
    headers: {
      get: (name) => (name === "content-type" ? "application/json" : null),
    },
    body: body(value),
  };
}
function receipt({
  trigger = 202,
  readback = 200,
  observations = [
    {
      pointer: "/ready",
      found: true,
      observedType: "boolean",
      observedHmacSha256: expectedDigest("/ready", true),
    },
  ],
} = {}) {
  const state =
    trigger === 202 &&
    readback === 200 &&
    observations.length === 1 &&
    observations[0].observedHmacSha256 === expectedDigest("/ready", true)
      ? "proven"
      : "not_proven";
  const observed =
    trigger !== 202
      ? `The safe job trigger /__agentrail/verification/jobs/run-1/trigger returned HTTP ${trigger}; the planned status was 202.`
      : readback !== 200
        ? `The safe job readback /__agentrail/verification/jobs/run-1/result returned HTTP ${readback}; the planned status was 200.`
        : state === "proven"
          ? "The safe job trigger and readback returned planned HTTP statuses; all 1 planned JSON scalar assertions matched."
          : "The safe job readback /__agentrail/verification/jobs/run-1/result returned HTTP 200; 1 of 1 planned JSON scalar assertions did not match.";
  return {
    ok: true,
    state,
    expected: context.expected,
    observed,
    observedTriggerStatus: trigger,
    observedReadbackStatus: trigger === 202 ? readback : null,
    assertionCount: 1,
    evidenceRef: "review-job-execution:job-execution-1",
    evidenceKey: "review-evidence/job.json",
    evidenceUrl: "https://artifacts.example.test/signed",
  };
}

test("one bodyless trigger and one immediate bounded readback yield a typed custodied receipt", async () => {
  const calls = [],
    completions = [];
  const execute = createReviewJobExecutor({
    keyring,
    fetchPreview: async (url, init) => {
      calls.push({ url, init });
      return init.method === "POST"
        ? { status: 202 }
        : jsonResponse({ ready: true });
    },
    completeExecution: async (value) => {
      completions.push(value);
      return receipt({
        trigger: value.observedTriggerStatus,
        readback: value.observedReadbackStatus,
        observations: value.observations,
      });
    },
  });
  assert.equal((await execute(context)).state, "proven");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://preview.example.test/__agentrail/verification/jobs/run-1/trigger",
      "https://preview.example.test/__agentrail/verification/jobs/run-1/result",
    ],
  );
  for (const call of calls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "error");
    assert.equal("body" in call.init, false);
    assert.equal("headers" in call.init, false);
  }
  assert.equal(completions.length, 1);
  assert.equal(completions[0].observations.length, 1);
});

test("a matching trigger never reads its response body before the one bounded result GET", async () => {
  const calls = [];
  const triggerResponse = { status: 202 };
  for (const property of ["body", "text", "json", "arrayBuffer"]) {
    Object.defineProperty(triggerResponse, property, {
      get() {
        throw new Error(`trigger ${property} must not be read`);
      },
    });
  }
  const execute = createReviewJobExecutor({
    keyring,
    fetchPreview: async (url, init) => {
      calls.push({ url, method: init.method });
      return init.method === "POST"
        ? triggerResponse
        : jsonResponse({ ready: true });
    },
    completeExecution: async (value) =>
      receipt({
        trigger: value.observedTriggerStatus,
        readback: value.observedReadbackStatus,
        observations: value.observations,
      }),
  });

  assert.equal((await execute(context)).state, "proven");
  assert.deepEqual(calls, [
    {
      url: "https://preview.example.test/__agentrail/verification/jobs/run-1/trigger",
      method: "POST",
    },
    {
      url: "https://preview.example.test/__agentrail/verification/jobs/run-1/result",
      method: "GET",
    },
  ]);
});

test("trigger mismatch has no readback and is a custodied not_proven result", async () => {
  let calls = 0,
    completed;
  const execute = createReviewJobExecutor({
    keyring,
    fetchPreview: async () => {
      calls += 1;
      return { status: 202 };
    },
    completeExecution: async (value) => {
      completed = value;
      return receipt({ trigger: 202, readback: null, observations: [] });
    },
  });
  const result = await execute({
    ...context,
    jobRequest: {
      ...context.jobRequest,
      trigger: { ...context.jobRequest.trigger, expectedStatus: 200 },
    },
  });
  assert.equal(result.state, "not_proven");
  assert.equal(calls, 1);
  assert.deepEqual(completed.observations, []);
  assert.equal(completed.observedReadbackStatus, null);
});

test("readback pending, scalar mismatch, redirects, and malformed paths do not claim failed proof or repeat the trigger", async () => {
  for (const readbackResponse of [
    jsonResponse({ ready: true }, 202),
    jsonResponse({ ready: false }),
  ]) {
    let posts = 0;
    const execute = createReviewJobExecutor({
      keyring,
      fetchPreview: async (_url, init) => {
        if (init.method === "POST") {
          posts += 1;
          return { status: 202 };
        }
        return readbackResponse;
      },
      completeExecution: async (value) =>
        receipt({
          trigger: value.observedTriggerStatus,
          readback: value.observedReadbackStatus,
          observations: value.observations,
        }),
    });
    assert.equal((await execute(context)).state, "not_proven");
    assert.equal(posts, 1);
  }
  let completed = 0;
  const redirected = createReviewJobExecutor({
    keyring,
    fetchPreview: async () => ({ status: 202, redirected: true }),
    completeExecution: async () => {
      completed += 1;
      return receipt();
    },
  });
  assert.equal((await redirected(context)).state, "not_proven");
  assert.equal(completed, 0);
  let previewCalls = 0;
  const invalid = createReviewJobExecutor({
    keyring,
    fetchPreview: async () => {
      previewCalls += 1;
      return { status: 202 };
    },
    completeExecution: async () => receipt(),
  });
  for (const jobRequest of [
    {
      ...context.jobRequest,
      trigger: { ...context.jobRequest.trigger, path: "/logout" },
    },
    {
      ...context.jobRequest,
      readback: {
        ...context.jobRequest.readback,
        path: "/__agentrail/verification/jobs/other/result",
      },
    },
  ])
    assert.equal(
      (await invalid({ ...context, jobRequest })).state,
      "not_testable",
    );
  assert.equal(previewCalls, 0);
});
