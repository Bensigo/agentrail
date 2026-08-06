import test from "node:test";
import assert from "node:assert/strict";

import { createVerificationApiExecutor } from "../agent/lib/verification_api_executor.core.mjs";

const item = {
  workspaceId: "workspace",
  previewUrl: "https://preview.example.test/pr/42",
  execution: { id: "execution", verificationPlanId: "plan" },
  plan: {
    modality: "api",
    recordId: "record",
    prRevisionId: "revision",
    criterionId: "health-api",
    expectedBehavior: "Health endpoint returns 200",
    apiRequest: { method: "GET", path: "/api/health", expectedStatus: 200 },
  },
};

function executor({ response = { status: 200, redirected: false }, fetchImpl, uploadArtifact } = {}) {
  return createVerificationApiExecutor({
    fetchImpl: fetchImpl ?? (async () => response),
    uploadArtifact: uploadArtifact ?? (async () => ({ artifactId: "artifact" })),
  });
}

test("executes only the exact planned GET and stores a plan-bound API card", async () => {
  let request;
  let upload;
  const result = await executor({
    fetchImpl: async (url, init) => { request = { url, init }; return { status: 200, redirected: false }; },
    uploadArtifact: async (input) => { upload = input; return { artifactId: "artifact" }; },
  })(item);
  assert.equal(result.status, "proven");
  assert.deepEqual(result.artifactIds, ["artifact"]);
  assert.equal(request.url, "https://preview.example.test/api/health");
  assert.deepEqual(request.init.method, "GET");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "error");
  assert.deepEqual(upload, {
    workspaceId: "workspace", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan",
    collectedBy: "verification-executor:execution", index: 1,
    evidence: {
      request: { method: "GET", url: "https://preview.example.test/api/health" },
      response: { status: 200 },
      assertions: ["criterion health-api: expected status 200; observed status 200"],
    },
  });
});

test("does not upload when a safe request returns the wrong status", async () => {
  const result = await executor({ response: { status: 503, redirected: false }, uploadArtifact: async () => { throw new Error("must not upload"); } })(item);
  assert.equal(result.status, "not_proven");
  assert.match(result.reason, /Expected API status 200 but observed 503/);
});

test("fails closed on unsafe descriptors, conflicting identity, and unsafe previews before fetch", async () => {
  let calls = 0;
  const run = executor({ fetchImpl: async () => { calls += 1; return { status: 200, redirected: false }; } });
  for (const changed of [
    { plan: { ...item.plan, apiRequest: { ...item.plan.apiRequest, path: "/api/health?token=x" } } },
    { plan: { ...item.plan, apiRequest: { ...item.plan.apiRequest, path: "//outside.example" } } },
    { prRevisionId: "other" },
    { previewUrl: "https://user:pass@preview.example.test" },
  ]) {
    const result = await run({ ...item, ...changed, plan: changed.plan ?? item.plan });
    assert.equal(result.status, "not_testable");
  }
  assert.equal(calls, 0);
});

test("returns not_proven for fetch redirects/failures and failed evidence storage", async () => {
  for (const options of [
    { response: { status: 200, redirected: true } },
    { fetchImpl: async () => { throw new Error("network"); } },
    { uploadArtifact: async () => ({ error: "storage disabled" }) },
  ]) {
    const result = await executor(options)(item);
    assert.equal(result.status, "not_proven");
    assert.equal(result.artifactIds.length, 0);
  }
});

test("requires complete claimed plan identity", async () => {
  const result = await executor()({ ...item, workspaceId: "" });
  assert.equal(result.status, "not_testable");
  assert.match(result.reason, /incomplete plan identity/);
});
