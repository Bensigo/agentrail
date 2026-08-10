import test from "node:test";
import assert from "node:assert/strict";

import { createReviewApiExecutor } from "../agent/lib/review_api_executor.core.mjs";

const context = {
  executionId: "api-execution-1",
  jobId: "job-1",
  criterionId: "criterion-api-1",
  expected: "GET /health returns 200.",
  previewBootId: "boot-1",
  previewUrl: "https://preview.example.test/",
  apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
};

function receipt(state = "proven", status = 200) {
  return {
    ok: true,
    state,
    expected: context.expected,
    observed: status === 200
      ? "The safe GET /health returned the planned HTTP 200."
      : `The safe GET /health returned HTTP ${status}; the planned status was 200.`,
    observedStatus: status,
    evidenceRef: "review-api-execution:api-execution-1",
    evidenceKey: "review-evidence/ws/repo/1/head/api/1.json",
    evidenceUrl: "https://artifacts.example.test/signed",
  };
}

test("executes only the persisted same-origin GET and accepts an exact proven receipt", async () => {
  const calls = [];
  const complete = [];
  const execute = createReviewApiExecutor({
    fetchPreview: async (url, init) => { calls.push({ url, init }); return { status: 200 }; },
    completeExecution: async (value) => { complete.push(value); return receipt(); },
  });
  assert.deepEqual(await execute(context), receipt());
  assert.equal(calls[0].url, "https://preview.example.test/health");
  assert.deepEqual(Object.keys(calls[0].init).sort(), ["credentials", "method", "redirect", "signal"]);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(complete, [{
    executionId: "api-execution-1", jobId: "job-1", criterionId: "criterion-api-1", previewBootId: "boot-1", observedStatus: 200,
  }]);
});

test("the exact server receipt may decisively attest an expected-status mismatch as failed", async () => {
  const execute = createReviewApiExecutor({
    fetchPreview: async () => ({ status: 503 }),
    completeExecution: async (value) => receipt("failed", value.observedStatus),
  });
  assert.deepEqual(await execute(context), receipt("failed", 503));
});

test("invalid descriptors cannot fetch or complete", async () => {
  let calls = 0;
  const execute = createReviewApiExecutor({
    fetchPreview: async () => { calls += 1; return { status: 200 }; },
    completeExecution: async () => { calls += 1; return receipt(); },
  });
  for (const apiRequest of [
    { method: "POST", path: "/health", expectedStatus: 200 },
    { method: "GET", path: "//evil.example.test", expectedStatus: 200 },
    { method: "GET", path: "/health?admin=1", expectedStatus: 200 },
    { method: "GET", path: "/health#fragment", expectedStatus: 200 },
    { method: "GET", path: "/a/%2e%2e/admin", expectedStatus: 200 },
    { method: "GET", path: "/health%3Fadmin=true", expectedStatus: 200 },
    { method: "GET", path: "/health%0AInjected", expectedStatus: 200 },
    { method: "GET", path: "/a/../admin", expectedStatus: 200 },
    { method: "GET", path: "/health", expectedStatus: 200, headers: { authorization: "no" } },
  ]) {
    assert.equal((await execute({ ...context, apiRequest })).state, "not_testable");
  }
  assert.equal((await execute({ ...context, previewUrl: "https://user:pass@preview.example.test/" })).state, "not_testable");
  assert.equal(calls, 0);
});

test("transport, redirect, timeout, malformed status, or a malformed receipt degrade without invented proof", async () => {
  const transportFailure = createReviewApiExecutor({ fetchPreview: async () => { throw new Error("redirect"); }, completeExecution: async () => receipt() });
  assert.equal((await transportFailure(context)).state, "not_proven");

  const redirected = createReviewApiExecutor({ fetchPreview: async () => ({ status: 200, redirected: true }), completeExecution: async () => receipt() });
  assert.equal((await redirected(context)).state, "not_proven");

  const malformedStatus = createReviewApiExecutor({ fetchPreview: async () => ({ status: 0 }), completeExecution: async () => receipt() });
  assert.equal((await malformedStatus(context)).state, "not_proven");

  const badReceipt = createReviewApiExecutor({ fetchPreview: async () => ({ status: 200 }), completeExecution: async () => ({ ...receipt(), state: "not_proven" }) });
  assert.equal((await badReceipt(context)).state, "not_proven");
  const mismatchedState = createReviewApiExecutor({ fetchPreview: async () => ({ status: 503 }), completeExecution: async () => receipt("proven", 503) });
  assert.equal((await mismatchedState(context)).state, "not_proven");
  const inventedObservation = createReviewApiExecutor({ fetchPreview: async () => ({ status: 200 }), completeExecution: async () => ({ ...receipt(), observed: "looks healthy" }) });
  assert.equal((await inventedObservation(context)).state, "not_proven");

  const noResponseBodyRead = createReviewApiExecutor({
    fetchPreview: async () => ({ status: 200, text: () => { throw new Error("body read"); }, json: () => { throw new Error("body read"); } }),
    completeExecution: async () => receipt(),
  });
  assert.deepEqual(await noResponseBodyRead(context), receipt());

  const timeout = createReviewApiExecutor({ fetchPreview: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), completeExecution: async () => receipt(), timeoutMs: 5 });
  assert.equal((await timeout(context)).state, "not_proven");
});

test("bad executor wiring and timeout bounds fail early", () => {
  assert.throws(() => createReviewApiExecutor({}), /fetchPreview/);
  assert.throws(() => createReviewApiExecutor({ fetchPreview: async () => {}, completeExecution: async () => {}, timeoutMs: 0 }), /timeoutMs/);
});
