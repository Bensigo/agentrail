import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createReviewDataExecutor as createExecutor, resolveDataHmacKeyring } from "../agent/lib/review_data_executor.core.mjs";

const digestContext = "a".repeat(64);
const digestKey = Buffer.alloc(32, 7);
const env = {
  REVIEW_DATA_HMAC_ACTIVE_KEY_ID: "current",
  REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify({ current: Buffer.alloc(32, 9).toString("base64url"), "old-key": digestKey.toString("base64url") }),
};
const keyring = resolveDataHmacKeyring(env);
function createReviewDataExecutor(options) { return createExecutor({ ...options, keyring }); }

test("HMAC keyring parsing is closed, canonical, bounded, and retains old execution keys", () => {
  assert.equal(keyring.activeKeyId, "current");
  assert.deepEqual([...keyring.keys.keys()].sort(), ["current", "old-key"]);
  for (const bad of [
    {},
    { ...env, REVIEW_DATA_HMAC_ACTIVE_KEY_ID: "missing" },
    { ...env, REVIEW_DATA_HMAC_ACTIVE_KEY_ID: "bad id" },
    { ...env, REVIEW_DATA_HMAC_KEYS_JSON: "[]" },
    { ...env, REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify({ current: `${Buffer.alloc(32).toString("base64url") }=` }) },
    { ...env, REVIEW_DATA_HMAC_KEYS_JSON: JSON.stringify({ current: Buffer.alloc(31).toString("base64url") }) },
  ]) assert.equal(resolveDataHmacKeyring(bad), null);
});

function expected(pointer, value) {
  const type = value === null ? "null" : typeof value;
  return { pointer, equalsType: type, equalsHmacSha256: createHmac("sha256", digestKey).update(JSON.stringify(["agentrail.review-data.scalar.v1", digestContext, pointer, type, value])).digest("hex") };
}

const context = {
  executionId: "data-execution-1",
  jobId: "job-1",
  criterionId: "criterion-data-1",
  expected: "Health payload is ready.",
  previewBootId: "boot-1",
  previewUrl: "https://preview.example.test/",
  dataRequest: {
    method: "GET",
    path: "/health",
    expectedStatus: 200,
    digestAlgorithm: "hmac-sha256-v1",
    digestKeyId: "old-key",
    digestContext,
    expectedJson: [
      expected("/ready", true),
      expected("/checks/0/name", "db"),
      expected("/a~1b/~0key", 7),
    ],
  },
};
function stream(value) {
  const bytes = new TextEncoder().encode(value);
  let read = false;
  return {
    getReader: () => ({
      read: async () =>
        read ? { done: true } : ((read = true), { done: false, value: bytes }),
      cancel: async () => {},
    }),
  };
}
function observation(json) {
  return [expected("/ready", json.ready), expected("/checks/0/name", json.checks[0].name), expected("/a~1b/~0key", json["a/b"]["~key"])].map(({ pointer, equalsType, equalsHmacSha256 }) => ({ pointer, found: true, observedType: equalsType, observedHmacSha256: equalsHmacSha256 }));
}
function receipt(observations, status = 200, state = "proven") {
  const passed = state === "proven";
  return {
    ok: true,
    state,
    expected: context.expected,
    observed:
      status !== 200
        ? `The safe data GET /health returned HTTP ${status}; the planned status was 200.`
        : passed
          ? "The safe data GET /health returned HTTP 200; all 3 planned JSON scalar assertions matched."
          : "The safe data GET /health returned HTTP 200; 1 of 3 planned JSON scalar assertions did not match.",
    observedStatus: status,
    assertionCount: context.dataRequest.expectedJson.length,
    evidenceRef: "review-data-execution:data-execution-1",
    evidenceKey: "review-evidence/ws/repo/1/head/data/1.json",
    evidenceUrl: "https://artifacts.example.test/signed",
  };
}
function jsonResponse(
  value,
  status = 200,
  headers = { "content-type": "application/json" },
) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: stream(typeof value === "string" ? value : JSON.stringify(value)),
  };
}

test("does one same-origin credentialless GET and reports only declared object and canonical-array scalar pointers", async () => {
  const json = {
    ready: true,
    checks: [{ name: "db" }],
    "a/b": { "~key": 7 },
    ignored: "never returned",
  };
  const calls = [];
  const completed = [];
  const execute = createReviewDataExecutor({
    fetchPreview: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(json);
    },
    completeExecution: async (value) => {
      completed.push(value);
      return receipt(value.observations);
    },
  });
  assert.deepEqual(await execute(context), receipt(observation(json)));
  assert.equal(calls[0].url, "https://preview.example.test/health");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(completed[0].observations, observation(json));
  assert.doesNotMatch(JSON.stringify(completed[0]), /"value"|never returned/);
  assert.doesNotMatch(
    JSON.stringify(await execute(context)),
    /ignored|"ready"|"checks"/,
  );
});

test("status mismatch completes decisively with empty observations; assertion mismatch, missing, and non-scalar targets fail without leakage", async () => {
  let got;
  const mismatch = createReviewDataExecutor({
    fetchPreview: async () =>
      jsonResponse("not json", 503, { "content-type": "text/plain" }),
    completeExecution: async (value) => {
      got = value;
      return receipt([], 503, "failed");
    },
  });
  assert.deepEqual(await mismatch(context), receipt([], 503, "failed"));
  assert.deepEqual(got.observations, []);
  for (const json of [
    { ready: false, checks: [{ name: "db" }], "a/b": { "~key": 7 } },
    { ready: "true", checks: [{ name: "db" }], "a/b": { "~key": 7 } },
    { ready: true, checks: [], "a/b": { "~key": 7 } },
    { ready: true, checks: [{ name: "db" }], "a/b": { "~key": {} } },
  ]) {
    const execute = createReviewDataExecutor({
      fetchPreview: async () => jsonResponse(json),
      completeExecution: async (value) =>
        receipt(value.observations, 200, "failed"),
    });
    assert.equal((await execute(context)).state, "failed");
  }
});

test("invalid descriptor, redirects, timeout, oversized/hanging/non-json/invalid JSON response, and malformed receipt degrade safely", async () => {
  let calls = 0;
  const invalid = createReviewDataExecutor({
    fetchPreview: async () => {
      calls += 1;
      return jsonResponse({});
    },
    completeExecution: async () => receipt([]),
  });
  for (const dataRequest of [
    { ...context.dataRequest, path: "/health?q=1" },
    { ...context.dataRequest, path: "//evil.test/x" },
    { ...context.dataRequest, digestKeyId: "not-retained" },
    {
      ...context.dataRequest,
      expectedJson: [expected("/token", true)],
    },
  ])
    assert.equal(
      (await invalid({ ...context, dataRequest })).state,
      "not_testable",
    );
  assert.equal(calls, 0);
  const redirect = createReviewDataExecutor({
    fetchPreview: async () => ({
      ...jsonResponse({ ready: true }),
      redirected: true,
    }),
    completeExecution: async () => receipt([]),
  });
  assert.equal((await redirect(context)).state, "not_proven");
  const cases = [
    jsonResponse("{}", 200, { "content-type": "text/plain" }),
    jsonResponse("{bad"),
    {
      ...jsonResponse({ ready: true }),
      headers: {
        get: (name) =>
          name === "content-type"
            ? "application/json"
            : name === "content-length"
              ? "70000"
              : null,
      },
    },
  ];
  for (const response of cases) {
    const execute = createReviewDataExecutor({
      fetchPreview: async () => response,
      completeExecution: async () => receipt([]),
    });
    assert.equal((await execute(context)).state, "not_proven");
  }
  const tooLargeStream = createReviewDataExecutor({
    fetchPreview: async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      body: {
        getReader: () => ({
          read: async () => ({
            done: false,
            value: new Uint8Array(64 * 1024 + 1),
          }),
          cancel: async () => {},
        }),
      },
    }),
    completeExecution: async () => receipt([]),
  });
  assert.equal((await tooLargeStream(context)).state, "not_proven");
  const hanging = createReviewDataExecutor({
    fetchPreview: async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
    }),
    completeExecution: async () => receipt([]),
    timeoutMs: 5,
  });
  assert.equal((await hanging(context)).state, "not_proven");
  const badReceipt = createReviewDataExecutor({
    fetchPreview: async () =>
      jsonResponse({
        ready: true,
        checks: [{ name: "db" }],
        "a/b": { "~key": 7 },
      }),
    completeExecution: async () => ({
      ...receipt(
        observation({
          ready: true,
          checks: [{ name: "db" }],
          "a/b": { "~key": 7 },
        }),
      ),
      assertionCount: 0,
    }),
  });
  assert.equal((await badReceipt(context)).state, "not_proven");
});
