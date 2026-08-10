import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewUiCompleteUrl,
  buildReviewUiStartUrl,
  runReviewUiExecution,
} from "../agent/lib/review_ui_execution_console.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.test/",
  JACE_CONSOLE_TOKEN: "secret",
};

const input = {
  eveSessionId: "eve-1",
  jobId: "job/1",
  criterionId: "AC-UI",
  previewBootId: "boot-1",
};

const context = {
  ok: true,
  executionId: "ui-execution-1",
  jobId: input.jobId,
  criterionId: input.criterionId,
  expected: "The saved state is visible.",
  previewBootId: input.previewBootId,
  previewUrl: "https://preview.example.test/",
  uiSteps: [
    { action: "open", path: "/settings" },
    { action: "expect_text", text: "Saved" },
    { action: "screenshot", label: "saved" },
  ],
};

const receipt = {
  ok: true,
  state: "proven",
  expected: context.expected,
  observed: "The deterministic browser observed the planned text.",
  evidenceRef: "review-ui-execution:ui-execution-1",
  evidenceKey: "review-evidence/ws/repo/1/head/ac/1.png",
  evidenceUrl: "https://artifacts.example.test/signed",
};

function response(status, body) {
  return { status, json: async () => body };
}

test("builds encoded job-scoped start and completion URLs", () => {
  assert.equal(
    buildReviewUiStartUrl("https://console.example.test", "job/a b"),
    "https://console.example.test/api/v1/runner/review-jobs/job%2Fa%20b/ui-executions/start",
  );
  assert.equal(
    buildReviewUiCompleteUrl("https://console.example.test", "job/a b", "ui/1"),
    "https://console.example.test/api/v1/runner/review-jobs/job%2Fa%20b/ui-executions/ui%2F1/complete",
  );
});

test("sends only opaque ids, projects the server context, and completes with only browser evidence", async () => {
  const calls = [];
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? response(201, context) : response(201, receipt);
    },
    execute: async ({ context: projected, completeExecution }) => {
      assert.deepEqual(projected, {
        executionId: context.executionId,
        jobId: context.jobId,
        criterionId: context.criterionId,
        expected: context.expected,
        previewBootId: context.previewBootId,
        previewUrl: context.previewUrl,
        uiSteps: context.uiSteps,
      });
      return completeExecution({
        executionId: projected.executionId,
        jobId: projected.jobId,
        criterionId: projected.criterionId,
        previewBootId: projected.previewBootId,
        assertionPassed: true,
        observedUrl: "https://preview.example.test/settings",
        imageBase64: "iVBORw0KGgo=",
        contentType: "image/png",
      });
    },
  });

  assert.deepEqual(result, receipt);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    eveSessionId: input.eveSessionId,
    criterionId: input.criterionId,
    previewBootId: input.previewBootId,
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    eveSessionId: input.eveSessionId,
    assertionPassed: true,
    observedUrl: "https://preview.example.test/settings",
    imageBase64: "iVBORw0KGgo=",
    contentType: "image/png",
  });
  assert.equal(calls.some(({ init }) => /repo|prNumber|headSha/u.test(init.body)), false);
});

test("does not reserve when configuration or opaque ids are missing", async () => {
  let calls = 0;
  for (const args of [
    { ...input, env: {} },
    { ...input, jobId: "", env: ENV },
  ]) {
    const result = await runReviewUiExecution({
      ...args,
      transport: async () => { calls += 1; },
      execute: async () => receipt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "not_testable");
  }
  assert.equal(calls, 0);
});

test("holds non-successful, unreachable, or mismatched reservations without browser execution", async () => {
  let executions = 0;
  for (const transport of [
    async () => response(409, { error: "held" }),
    async () => { throw new Error("offline"); },
    async () => response(201, { ...context, jobId: "foreign-job" }),
  ]) {
    const result = await runReviewUiExecution({
      ...input,
      env: ENV,
      transport,
      execute: async () => { executions += 1; return receipt; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "not_proven");
  }
  assert.equal(executions, 0);
});

test("completion is one-shot and rejects conflicting internal coordinates", async () => {
  let transportCalls = 0;
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async () => {
      transportCalls += 1;
      return response(201, context);
    },
    execute: async ({ context: projected, completeExecution }) => {
      await assert.rejects(() => completeExecution({
        executionId: projected.executionId,
        jobId: "foreign-job",
        criterionId: projected.criterionId,
        previewBootId: projected.previewBootId,
        assertionPassed: true,
        observedUrl: projected.previewUrl,
        imageBase64: "aW1hZ2U=",
        contentType: "image/png",
      }));
      return { ok: false, degraded: true, state: "not_proven" };
    },
  });
  assert.equal(result.state, "not_proven");
  assert.equal(transportCalls, 1);
});

test("completion has an exact IDs-only body and cannot write twice", async () => {
  const calls = [];
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? response(201, context) : response(201, receipt);
    },
    execute: async ({ context: projected, completeExecution }) => {
      const value = {
        executionId: projected.executionId,
        jobId: projected.jobId,
        criterionId: projected.criterionId,
        previewBootId: projected.previewBootId,
        assertionPassed: true,
        observedUrl: "https://preview.example.test/settings",
        imageBase64: "aW1hZ2U=",
        contentType: "image/png",
      };
      const first = await completeExecution(value);
      await assert.rejects(() => completeExecution(value));
      return first;
    },
  });

  assert.deepEqual(result, receipt);
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)).sort(), [
    "criterionId", "eveSessionId", "previewBootId",
  ]);
  assert.deepEqual(Object.keys(JSON.parse(calls[1].init.body)).sort(), [
    "assertionPassed", "contentType", "eveSessionId", "imageBase64", "observedUrl",
  ]);
  assert.doesNotMatch(calls[1].init.body, /executionId|jobId|criterionId|previewBootId|repo|prNumber|headSha/u);
});

test("a rejected completion cannot become an attested result", async () => {
  let calls = 0;
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async () => {
      calls += 1;
      return calls === 1 ? response(201, context) : response(409, { error: "held" });
    },
    execute: async ({ context: projected, completeExecution }) => {
      try {
        return await completeExecution({
          executionId: projected.executionId,
          jobId: projected.jobId,
          criterionId: projected.criterionId,
          previewBootId: projected.previewBootId,
          assertionPassed: false,
          observedUrl: projected.previewUrl,
          imageBase64: "aW1hZ2U=",
          contentType: "image/png",
        });
      } catch {
        return { ok: false, degraded: true, state: "not_proven" };
      }
    },
  });
  assert.deepEqual(result, { ok: false, degraded: true, state: "not_proven" });
  assert.equal(calls, 2, "a 4xx completion refusal must not be retried");
});

test("retries one exact content-addressed completion after a transport error", async () => {
  const calls = [];
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return response(201, context);
      if (calls.length === 2) throw new Error("connection reset after upload");
      return response(201, receipt);
    },
    execute: async ({ context: projected, completeExecution }) => completeExecution({
      executionId: projected.executionId,
      jobId: projected.jobId,
      criterionId: projected.criterionId,
      previewBootId: projected.previewBootId,
      assertionPassed: true,
      observedUrl: "https://preview.example.test/settings",
      imageBase64: "aW1hZ2U=",
      contentType: "image/png",
    }),
  });
  assert.deepEqual(result, receipt);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, calls[2].url);
  assert.equal(calls[1].init, calls[2].init, "retry must reuse the exact content-addressed request");
});

test("retries one exact completion after 5xx, but never retries reservation/start", async () => {
  const completionCalls = [];
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async (url, init) => {
      completionCalls.push({ url, init });
      if (completionCalls.length === 1) return response(201, context);
      if (completionCalls.length === 2) return response(503, { error: "upstream" });
      return response(201, receipt);
    },
    execute: async ({ context: projected, completeExecution }) => completeExecution({
      executionId: projected.executionId,
      jobId: projected.jobId,
      criterionId: projected.criterionId,
      previewBootId: projected.previewBootId,
      assertionPassed: true,
      observedUrl: "https://preview.example.test/settings",
      imageBase64: "aW1hZ2U=",
      contentType: "image/png",
    }),
  });
  assert.deepEqual(result, receipt);
  assert.equal(completionCalls.length, 3);
  assert.equal(completionCalls[1].url, completionCalls[2].url);
  assert.equal(completionCalls[1].init, completionCalls[2].init);

  let startCalls = 0;
  let executions = 0;
  const startFailure = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async () => { startCalls += 1; return response(503, { error: "upstream" }); },
    execute: async () => { executions += 1; return receipt; },
  });
  assert.equal(startFailure.state, "not_proven");
  assert.equal(startCalls, 1, "reservation/start must not be retried");
  assert.equal(executions, 0);
});

test("malformed reservations, executor failures, and non-object executor output degrade without a completion write", async () => {
  for (const execute of [
    async () => { throw new Error("browser failed"); },
    async () => null,
  ]) {
    let calls = 0;
    const result = await runReviewUiExecution({
      ...input,
      env: ENV,
      transport: async () => { calls += 1; return response(201, context); },
      execute,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "not_proven");
    assert.equal(calls, 1);
  }

  let executed = false;
  const result = await runReviewUiExecution({
    ...input,
    env: ENV,
    transport: async () => response(201, { ...context, extra: "not closed" }),
    execute: async () => { executed = true; return receipt; },
  });
  assert.equal(result.reason, "bad_body");
  assert.equal(executed, false);
});
