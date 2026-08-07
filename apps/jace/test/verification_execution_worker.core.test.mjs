import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { createVerificationApiExecutor } from "../agent/lib/verification_api_executor.core.mjs";
import { createVerificationExecutionWorker } from "../agent/lib/verification_execution_worker.core.mjs";

function makeUiItem(overrides = {}) {
  return {
    workerId: "worker",
    execution: { id: "execution", verificationPlanId: "plan" },
    workspaceId: "ws",
    plan: {
      recordId: "record",
      prRevisionId: "revision",
      criterionId: "saved",
      modality: "ui",
      flow: "save",
      uiSteps: [
        { action: "open", path: "/drafts/new" },
        { action: "screenshot", label: "saved" },
      ],
      expectedBehavior: "Saved",
    },
    previewUrl: "https://safe",
    ...overrides,
  };
}

function makeApiItem(overrides = {}) {
  return {
    workerId: "worker",
    execution: { id: "execution", verificationPlanId: "plan" },
    workspaceId: "ws",
    previewUrl: "https://preview.example.test/pr/42",
    plan: {
      recordId: "record",
      prRevisionId: "revision",
      criterionId: "health-api",
      modality: "api",
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

test("missing exact preview becomes not_testable without invoking the executor", async () => {
  let executed = false;
  const completed = [];
  const worker = createVerificationExecutionWorker({
    claim: async () => ({ ...makeUiItem(), previewUrl: null }),
    execute: async () => {
      executed = true;
    },
    complete: async (x) => completed.push(x),
  });

  assert.equal(await worker.tick(), "not_testable");
  assert.equal(executed, false);
  assert.equal(completed[0].status, "not_testable");
});

test("a booting preview is not claimed for execution", async () => {
  let executed = false;
  let completed = false;
  const worker = createVerificationExecutionWorker({
    claim: async () => null,
    execute: async () => {
      executed = true;
    },
    complete: async () => {
      completed = true;
    },
  });

  assert.equal(await worker.tick(), "idle");
  assert.equal(executed, false);
  assert.equal(completed, false);
});

test("only evidence-bound executor results can become proven", async () => {
  const completed = [];
  const worker = createVerificationExecutionWorker({
    claim: async () => makeUiItem(),
    execute: async () => ({ status: "proven", observedBehavior: "Saved", artifactIds: ["artifact"], reason: null }),
    complete: async (x) => completed.push(x),
  });

  assert.equal(await worker.tick(), "proven");
  assert.equal(completed[0].status, "proven");
});

test("a claimed pass without artifact is downgraded", async () => {
  const completed = [];
  const worker = createVerificationExecutionWorker({
    claim: async () => makeUiItem(),
    execute: async () => ({ status: "proven", observedBehavior: "Saved", artifactIds: [] }),
    complete: async (x) => completed.push(x),
  });

  assert.equal(await worker.tick(), "not_proven");
  assert.equal(completed[0].status, "not_proven");
});

test("a historical UI plan without persisted actions is terminalized without invoking the executor", async () => {
  let executed = false;
  const completed = [];
  const worker = createVerificationExecutionWorker({
    claim: async () => ({ ...makeUiItem(), plan: { ...makeUiItem().plan, uiSteps: null } }),
    execute: async () => {
      executed = true;
    },
    complete: async (input) => completed.push(input),
  });

  assert.equal(await worker.tick(), "not_testable");
  assert.equal(executed, false);
  assert.equal(completed[0].resultReason, "Planned UI criterion has no persisted safe uiSteps action list");
});

test("a missing or unsupported modality cannot route into an executor", async () => {
  let executed = false;
  const completed = [];
  const worker = createVerificationExecutionWorker({
    claim: async () => ({ ...makeUiItem(), plan: { ...makeUiItem().plan, modality: null } }),
    execute: async () => {
      executed = true;
    },
    complete: async (input) => completed.push(input),
  });

  assert.equal(await worker.tick(), "not_testable");
  assert.equal(executed, false);
  assert.equal(completed[0].resultReason, "Planned verification modality is missing or unsupported");
});

test("a local-only worker can claim in memory, hit a loopback API, and complete without console/model/db calls", async () => {
  await withLoopbackServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/health");
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (origin) => {
    const completed = [];
    const worker = createVerificationExecutionWorker({
      claim: async () => makeApiItem({ previewUrl: `${origin}/pr/42` }),
      execute: createVerificationApiExecutor({
        fetchImpl: globalThis.fetch,
        uploadArtifact: async (input) => {
          assert.deepEqual(input.evidence.response, { status: 200 });
          return { artifactId: "artifact-1" };
        },
      }),
      complete: async (input) => completed.push(input),
    });

    assert.equal(await worker.tick(), "proven");
    assert.deepEqual(completed, [
      {
        executionId: "execution",
        workerId: "worker",
        status: "proven",
        observedBehavior: "Observed exact planned GET /api/health status 200",
        artifactIds: ["artifact-1"],
        resultReason: null,
      },
    ]);
  });
});
