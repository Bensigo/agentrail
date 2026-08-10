import test from "node:test";
import assert from "node:assert/strict";
import { createReviewApiExecuteFn } from "../agent/lib/review_api_executor.mjs";

const env = { JACE_CONSOLE_BASE_URL: "https://console.example.test/", JACE_CONSOLE_TOKEN: "secret" };
const input = { eveSessionId: "eve-1", jobId: "job-1", criterionId: "AC-API", previewBootId: "boot-1" };
const context = { ok: true, executionId: "api-1", jobId: "job-1", criterionId: "AC-API", expected: "Health works.", previewBootId: "boot-1", previewUrl: "https://preview.example.test/", apiRequest: { method: "GET", path: "/health", expectedStatus: 200 } };
const receipt = { ok: true, state: "proven", expected: "Health works.", observed: "The safe GET /health returned the planned HTTP 200.", observedStatus: 200, evidenceRef: "review-api-execution:api-1", evidenceKey: "review-evidence/ws/repo/1/head/api/1.json", evidenceUrl: "https://artifacts.example.test/signed" };
function response(status, body) { return { status, json: async () => body }; }

test("production composition passes no caller-controlled HTTP settings to preview fetch", async () => {
  const consoleCalls = []; const previewCalls = [];
  const execute = createReviewApiExecuteFn({
    env,
    transport: async (url, init) => { consoleCalls.push({ url, init }); return consoleCalls.length === 1 ? response(201, context) : response(201, receipt); },
    fetchPreview: async (url, init) => { previewCalls.push({ url, init }); return { status: 200 }; },
  });
  assert.deepEqual(await execute(input), receipt);
  assert.deepEqual(previewCalls[0].url, "https://preview.example.test/health");
  assert.equal(previewCalls[0].init.method, "GET"); assert.equal(previewCalls[0].init.redirect, "error"); assert.equal(previewCalls[0].init.credentials, "omit");
  assert.deepEqual(JSON.parse(consoleCalls[1].init.body), { eveSessionId: "eve-1", observedStatus: 200 });
});
