import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewDataCompleteUrl,
  buildReviewDataStartUrl,
  runReviewDataExecution,
} from "../agent/lib/review_data_execution_console.core.mjs";

const env = {
  JACE_CONSOLE_BASE_URL: "https://console.example.test/",
  JACE_CONSOLE_TOKEN: "secret",
};
const input = {
  eveSessionId: "eve-1",
  jobId: "job/1",
  criterionId: "AC-DATA",
  previewBootId: "boot-1",
  keyring: { activeKeyId: "current", keys: new Map([["old-key", Buffer.alloc(32, 7)], ["current", Buffer.alloc(32, 9)]]) },
};
const dataRequest = {
  method: "GET",
  path: "/health",
  expectedStatus: 200,
  digestAlgorithm: "hmac-sha256-v1",
  digestKeyId: "old-key",
  digestContext: "a".repeat(64),
  expectedJson: [{
    pointer: "/ready",
    equalsType: "boolean",
    equalsHmacSha256: "b".repeat(64),
  }],
};
const context = {
  ok: true,
  executionId: "data/1",
  jobId: input.jobId,
  criterionId: input.criterionId,
  expected: "Health payload is ready.",
  previewBootId: input.previewBootId,
  previewUrl: "https://preview.example.test/",
  dataRequest,
};
const observations = [{
  pointer: "/ready",
  found: true,
  observedType: "boolean",
  observedHmacSha256: "b".repeat(64),
}];
const receipt = {
  ok: true,
  state: "proven",
  expected: context.expected,
  observed:
    "The safe data GET /health returned HTTP 200; all 1 planned JSON scalar assertions matched.",
  observedStatus: 200,
  assertionCount: 1,
  evidenceRef: "review-data-execution:data/1",
  evidenceKey: "review-evidence/ws/repo/1/head/data/1.json",
  evidenceUrl: "https://artifacts.example.test/signed",
};
const response = (status, body) => ({ status, json: async () => body });

test("uses encoded job-scoped data endpoints and closed request bodies", async () => {
  assert.equal(
    buildReviewDataStartUrl("https://console.example.test", "job/a b"),
    "https://console.example.test/api/v1/runner/review-jobs/job%2Fa%20b/data-executions/start",
  );
  assert.equal(
    buildReviewDataCompleteUrl(
      "https://console.example.test",
      "job/a b",
      "data/1",
    ),
    "https://console.example.test/api/v1/runner/review-jobs/job%2Fa%20b/data-executions/data%2F1/complete",
  );
  const calls = [];
  const result = await runReviewDataExecution({
    ...input,
    env,
    transport: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? response(201, context)
        : response(201, receipt);
    },
    execute: ({ context: projected, completeExecution }) => {
      assert.equal(projected.executionId, "data/1");
      assert.deepEqual(projected.dataRequest, dataRequest);
      return completeExecution({
        executionId: projected.executionId,
        jobId: projected.jobId,
        criterionId: projected.criterionId,
        previewBootId: projected.previewBootId,
        observedStatus: 200,
        observations,
      });
    },
  });
  assert.deepEqual(result, receipt);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    eveSessionId: "eve-1",
    criterionId: "AC-DATA",
    previewBootId: "boot-1",
    digestKeyIds: ["current", "old-key"],
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    eveSessionId: "eve-1",
    observedStatus: 200,
    observations,
  });
  assert.doesNotMatch(calls[1].init.body, /"value"/);
  assert.doesNotMatch(
    calls[1].init.body,
    /executionId|jobId|criterionId|previewBootId|previewUrl|dataRequest|headSha/u,
  );
});

test("start never retries; completion retries exactly once on transport or 5xx and rejects malformed completion", async () => {
  let starts = 0;
  assert.equal(
    (
      await runReviewDataExecution({
        ...input,
        env,
        transport: async () => {
          starts += 1;
          throw new Error("offline");
        },
        execute: async () => {
          throw new Error("must not execute");
        },
      })
    ).reason,
    "unreachable",
  );
  assert.equal(starts, 1);
  const calls = [];
  const result = await runReviewDataExecution({
    ...input,
    env,
    transport: async (_url, init) => {
      calls.push(init);
      return calls.length === 1
        ? response(201, context)
        : calls.length === 2
          ? response(503, {})
          : response(201, receipt);
    },
    execute: ({ context: item, completeExecution }) =>
      completeExecution({
        executionId: item.executionId,
        jobId: item.jobId,
        criterionId: item.criterionId,
        previewBootId: item.previewBootId,
        observedStatus: 200,
        observations,
      }),
  });
  assert.deepEqual(result, receipt);
  assert.equal(calls.length, 3);
  const malformed = await runReviewDataExecution({
    ...input,
    env,
    transport: async () => response(201, context),
    execute: async ({ context: item, completeExecution }) => {
      await assert.rejects(() =>
        completeExecution({
          executionId: item.executionId,
          jobId: item.jobId,
          criterionId: item.criterionId,
          previewBootId: item.previewBootId,
          observedStatus: 200,
          observations: [],
        }),
      );
      return { ok: false, degraded: true, state: "not_proven" };
    },
  });
  assert.equal(malformed.state, "not_proven");
});

test("an unexpected status is completed once with an exact empty observation set and returns the decisive failed receipt", async () => {
  const failed = {
    ...receipt,
    state: "failed",
    observed:
      "The safe data GET /health returned HTTP 503; the planned status was 200.",
    observedStatus: 503,
  };
  const calls = [];
  const result = await runReviewDataExecution({
    ...input,
    env,
    transport: async (_url, init) => {
      calls.push(init);
      return calls.length === 1
        ? response(201, context)
        : response(201, failed);
    },
    execute: ({ context: item, completeExecution }) =>
      completeExecution({
        executionId: item.executionId,
        jobId: item.jobId,
        criterionId: item.criterionId,
        previewBootId: item.previewBootId,
        observedStatus: 503,
        observations: [],
      }),
  });
  assert.deepEqual(result, failed);
  assert.deepEqual(JSON.parse(calls[1].body), {
    eveSessionId: "eve-1",
    observedStatus: 503,
    observations: [],
  });
  assert.equal(result.assertionCount, dataRequest.expectedJson.length);
});

test("invalid context and data descriptor fail closed without execution", async () => {
  assert.equal(
    (
      await runReviewDataExecution({
        ...input,
        env: {},
        transport: async () => {},
        execute: async () => {},
      })
    ).state,
    "not_testable",
  );
  const result = await runReviewDataExecution({
    ...input,
    env,
    transport: async () =>
      response(201, {
        ...context,
        dataRequest: { ...dataRequest, expectedJson: [] },
      }),
    execute: async () => {
      throw new Error("must not execute");
    },
  });
  assert.equal(result.reason, "bad_body");
});

test("missing local keyring fails before the at-most-once start reservation", async () => {
  let calls = 0;
  const result = await runReviewDataExecution({
    ...input,
    keyring: null,
    env,
    transport: async () => { calls += 1; },
    execute: async () => {},
  });
  assert.equal(result.state, "not_testable");
  assert.equal(calls, 0);
});

test("completion rejects raw-value observations before transport", async () => {
  let calls = 0;
  const result = await runReviewDataExecution({
    ...input,
    env,
    transport: async () => {
      calls += 1;
      return response(201, context);
    },
    execute: async ({ context: item, completeExecution }) => {
      await assert.rejects(() => completeExecution({
        executionId: item.executionId,
        jobId: item.jobId,
        criterionId: item.criterionId,
        previewBootId: item.previewBootId,
        observedStatus: 200,
        observations: [{ pointer: "/ready", found: true, value: true }],
      }));
      return { ok: false, degraded: true, state: "not_proven" };
    },
  });
  assert.equal(result.state, "not_proven");
  assert.equal(calls, 1);
});
