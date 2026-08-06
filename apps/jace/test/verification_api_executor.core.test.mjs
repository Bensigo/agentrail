import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { createVerificationApiExecutor } from "../agent/lib/verification_api_executor.core.mjs";

function makeItem(overrides = {}) {
  return {
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
    ...overrides,
  };
}

async function withLoopbackServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected loopback server address");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function executor({ fetchImpl, uploadArtifact, timeoutMs } = {}) {
  return createVerificationApiExecutor({
    fetchImpl: fetchImpl ?? globalThis.fetch,
    uploadArtifact: uploadArtifact ?? (async () => ({ artifactId: "artifact" })),
    timeoutMs,
  });
}

test("executes the exact same-origin GET against a loopback preview and stores plan-bound evidence", async () => {
  let request;
  await withLoopbackServer((req, res) => {
    request = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  }, async (origin) => {
    const item = makeItem({ previewUrl: `${origin}/pr/42` });
    let upload;
    const result = await executor({
      uploadArtifact: async (input) => {
        upload = input;
        return { artifactId: "artifact-1" };
      },
    })(item);

    assert.equal(result.status, "proven");
    assert.deepEqual(result.artifactIds, ["artifact-1"]);
    assert.equal(result.observedBehavior, "Observed exact planned GET /api/health status 200");
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/api/health");
    assert.equal(request.authorization, undefined);
    assert.equal(request.cookie, undefined);
    assert.deepEqual(upload, {
      workspaceId: "workspace",
      recordId: "record",
      prRevisionId: "revision",
      verificationPlanId: "plan",
      collectedBy: "verification-executor:execution",
      index: 1,
      evidence: {
        request: { method: "GET", url: `${origin}/api/health` },
        response: { status: 200 },
        assertions: ["criterion health-api: expected status 200; observed status 200"],
      },
    });
  });
});

test("does not upload when the loopback response status does not match the planned expected status", async () => {
  await withLoopbackServer((req, res) => {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("down");
  }, async (origin) => {
    let uploads = 0;
    const result = await executor({
      uploadArtifact: async () => {
        uploads += 1;
        throw new Error("must not upload");
      },
    })(
      makeItem({ previewUrl: `${origin}/pr/42` }),
    );

    assert.equal(result.status, "not_proven");
    assert.match(result.reason, /Expected API status 200 but observed 503/);
    assert.equal(uploads, 0);
  });
});

test("fails closed before fetch on unsafe descriptors, unsafe previews, and incomplete claimed identity", async () => {
  let calls = 0;
  const run = executor({
    fetchImpl: async () => {
      calls += 1;
      return { status: 200, redirected: false };
    },
  });

  for (const changed of [
    { plan: { ...makeItem().plan, apiRequest: { ...makeItem().plan.apiRequest, path: "/api/../secret" } } },
    { plan: { ...makeItem().plan, apiRequest: { ...makeItem().plan.apiRequest, path: "/api/health?token=x" } } },
    { plan: { ...makeItem().plan, apiRequest: { ...makeItem().plan.apiRequest, path: "//outside.example" } } },
    { plan: { ...makeItem().plan, apiRequest: { ...makeItem().plan.apiRequest, path: "https://preview.example.test/api/health" } } },
    { previewUrl: "https://user:pass@preview.example.test" },
    { workspaceId: "" },
  ]) {
    const result = await run({ ...makeItem(), ...changed, plan: changed.plan ?? makeItem().plan });
    assert.equal(result.status, "not_testable");
  }

  assert.equal(calls, 0);
});

test("returns not_proven for redirect responses, fetch failures, and upload failures", async () => {
  const redirected = await executor({
    fetchImpl: async () => ({ status: 200, redirected: true }),
  })(makeItem());
  assert.equal(redirected.status, "not_proven");

  const fetchFailure = await executor({
    fetchImpl: async () => {
      throw new Error("network");
    },
  })(makeItem());
  assert.equal(fetchFailure.status, "not_proven");

  const uploadFailure = await executor({
    uploadArtifact: async () => ({ error: "storage disabled" }),
  })(makeItem());
  assert.equal(uploadFailure.status, "not_proven");
});
