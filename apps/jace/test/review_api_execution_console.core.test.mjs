import test from "node:test";
import assert from "node:assert/strict";

import { buildReviewApiCompleteUrl, buildReviewApiStartUrl, runReviewApiExecution } from "../agent/lib/review_api_execution_console.core.mjs";

const env = { JACE_CONSOLE_BASE_URL: "https://console.example.test/", JACE_CONSOLE_TOKEN: "secret" };
const input = { eveSessionId: "eve-1", jobId: "job/1", criterionId: "AC-API", previewBootId: "boot-1" };
const context = {
  ok: true, executionId: "api/1", jobId: input.jobId, criterionId: input.criterionId, expected: "Health is healthy.", previewBootId: input.previewBootId,
  previewUrl: "https://preview.example.test/", apiRequest: { method: "GET", path: "/health", expectedStatus: 200 },
};
const receipt = { ok: true, state: "proven", expected: context.expected, observed: "The safe GET /health returned the planned HTTP 200.", observedStatus: 200, evidenceRef: "review-api-execution:api/1", evidenceKey: "review-evidence/ws/repo/1/head/api/1.json", evidenceUrl: "https://artifacts.example.test/signed" };
function response(status, body) { return { status, json: async () => body }; }

test("builds encoded job-scoped API URLs", () => {
  assert.equal(buildReviewApiStartUrl("https://console.example.test", "job/a b"), "https://console.example.test/api/v1/runner/review-jobs/job%2Fa%20b/api-executions/start");
  assert.equal(buildReviewApiCompleteUrl("https://console.example.test", "job/a b", "api/1"), "https://console.example.test/api/v1/runner/review-jobs/job%2Fa%20b/api-executions/api%2F1/complete");
});

test("sends only opaque ids to start and only the observed status to complete", async () => {
  const calls = [];
  const result = await runReviewApiExecution({
    ...input, env,
    transport: async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? response(201, context) : response(201, receipt); },
    execute: async ({ context: projected, completeExecution }) => {
      const { ok, ...serverContext } = context;
      assert.deepEqual(projected, serverContext);
      return completeExecution({ executionId: projected.executionId, jobId: projected.jobId, criterionId: projected.criterionId, previewBootId: projected.previewBootId, observedStatus: 200 });
    },
  });
  assert.deepEqual(result, receipt);
  assert.deepEqual(JSON.parse(calls[0].init.body), { eveSessionId: "eve-1", criterionId: "AC-API", previewBootId: "boot-1" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { eveSessionId: "eve-1", observedStatus: 200 });
  assert.doesNotMatch(calls[1].init.body, /executionId|jobId|criterionId|previewBootId|repo|prNumber|headSha|apiRequest/u);
});

test("start never retries; completion retries exactly once only after transport or 5xx", async () => {
  let calls = 0;
  const startFailure = await runReviewApiExecution({ ...input, env, transport: async () => { calls += 1; throw new Error("offline"); }, execute: async () => { throw new Error("must not execute"); } });
  assert.equal(startFailure.reason, "unreachable"); assert.equal(calls, 1);

  const completeCalls = [];
  const result = await runReviewApiExecution({
    ...input, env,
    transport: async (url, init) => { completeCalls.push({ url, init }); if (completeCalls.length === 1) return response(201, context); if (completeCalls.length === 2) return response(503, {}); return response(201, receipt); },
    execute: ({ context: projected, completeExecution }) => completeExecution({ executionId: projected.executionId, jobId: projected.jobId, criterionId: projected.criterionId, previewBootId: projected.previewBootId, observedStatus: 200 }),
  });
  assert.deepEqual(result, receipt); assert.equal(completeCalls.length, 3);

  let refusalCalls = 0;
  const refusal = await runReviewApiExecution({
    ...input, env,
    transport: async () => { refusalCalls += 1; return refusalCalls === 1 ? response(201, context) : response(409, {}); },
    execute: async ({ context: projected, completeExecution }) => { try { return await completeExecution({ executionId: projected.executionId, jobId: projected.jobId, criterionId: projected.criterionId, previewBootId: projected.previewBootId, observedStatus: 200 }); } catch { return { ok: false, degraded: true, state: "not_proven" }; } },
  });
  assert.equal(refusal.state, "not_proven"); assert.equal(refusalCalls, 2);
});

test("malformed input/configuration/start context degrades without execution", async () => {
  assert.equal((await runReviewApiExecution({ ...input, env: {}, transport: async () => {}, execute: async () => {} })).state, "not_testable");
  const result = await runReviewApiExecution({ ...input, env, transport: async () => response(201, { ...context, apiRequest: { method: "POST" } }), execute: async () => { throw new Error("must not execute"); } });
  assert.equal(result.reason, "bad_body");
});
