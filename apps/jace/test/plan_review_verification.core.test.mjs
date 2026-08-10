import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationPlanUrl,
  normalizeApiRequest,
  normalizeDataPointer,
  normalizeDataRequest,
  normalizeJobRequest,
  normalizePlans,
  normalizeUiSteps,
  planReviewVerification,
} from "../agent/lib/plan_review_verification.core.mjs";

const env = { JACE_CONSOLE_BASE_URL: "https://console.example.com/", JACE_CONSOLE_TOKEN: "token" };
const plans = [
  {
    criterionId: "ac-ui", modality: "ui", status: "planned", flow: "Open /settings and save.",
    uiSteps: [
      { action: "open", path: "/settings" },
      { action: "click", selector: "[data-testid=\"save\"]" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "saved-settings" },
    ],
  },
  { criterionId: "ac-api", modality: "api", status: "planned", flow: "Health response status is decisive.", apiRequest: { method: "GET", path: "/health", expectedStatus: 200 } },
  {
    criterionId: "ac-data",
    modality: "data",
    status: "planned",
    flow: "The health payload declares readiness.",
    dataRequest: {
      method: "GET",
      path: "/health",
      expectedStatus: 200,
      expectedJson: [
        { pointer: "/ready", equals: true },
        { pointer: "/checks/0/name", equals: "db" },
      ],
    },
  },
];

test("buildVerificationPlanUrl encodes the server-bound job id", () => {
  assert.equal(
    buildVerificationPlanUrl("https://console.example.com", "job/a b"),
    "https://console.example.com/api/v1/runner/review-jobs/job%2Fa%20b/verification-plan",
  );
});

test("normalizeDataRequest admits only bounded strict JSON-scalar readback descriptors", () => {
  const request = plans[2].dataRequest;
  assert.deepEqual(normalizeDataRequest(request), request);
  assert.equal(normalizeDataPointer("/a~1b/~0key/0"), "/a~1b/~0key/0");
  for (const pointer of [
    "",
    "root",
    "/bad~2escape",
    "/bad~",
    "/bad\nkey",
    "/token",
    "/refreshToken",
    "/passwordHash",
    "/otp",
    "/pinCode",
    "/customerEmail",
    "/billingAddress",
    "/tax-id",
    "/a~1b/client_secret",
  ])
    assert.equal(normalizeDataPointer(pointer), null);
  for (const invalid of [
    { ...request, expectedJson: [] },
    { ...request, expectedJson: [{ pointer: "/x", equals: {} }] },
    {
      ...request,
      expectedJson: [
        { pointer: "/x", equals: 1 },
        { pointer: "/x", equals: 2 },
      ],
    },
    { ...request, path: "/health?all=1" },
    { ...request, path: "https://evil.example.test/health" },
    { ...request, expectedJson: [{ pointer: "/x", equals: "person@example.com" }] },
    { ...request, expectedJson: [{ pointer: "/x", equals: "123-45-6789" }] },
    { ...request, expectedJson: [{ pointer: "/x", equals: 100_000_000 }] },
    {
      ...request,
      expectedJson: [{ pointer: "/x", equals: true, extra: true }],
    },
  ])
    assert.equal(normalizeDataRequest(invalid), null);
});

test("normalizeJobRequest admits only one paired preview-local POST and immediate scalar readback", () => {
  const jobRequest = {
    trigger: { method: "POST", path: "/__agentrail/verification/jobs/run-1/trigger", expectedStatus: 202 },
    readback: {
      method: "GET",
      path: "/__agentrail/verification/jobs/run-1/result",
      expectedStatus: 200,
      expectedJson: [{ pointer: "/ready", equals: true }],
    },
  };
  assert.deepEqual(normalizeJobRequest(jobRequest), jobRequest);
  for (const invalid of [
    { ...jobRequest, trigger: { ...jobRequest.trigger, method: "GET" } },
    { ...jobRequest, trigger: { ...jobRequest.trigger, path: "/__agentrail/verification/jobs/run-1/result" } },
    { ...jobRequest, readback: { ...jobRequest.readback, path: "/__agentrail/verification/jobs/other/result" } },
    { ...jobRequest, trigger: { ...jobRequest.trigger, path: "/__agentrail/verification/jobs/run%2d1/trigger" } },
    { ...jobRequest, trigger: { ...jobRequest.trigger, expectedStatus: 199 } },
    { ...jobRequest, readback: { ...jobRequest.readback, expectedStatus: 300 } },
  ]) assert.equal(normalizeJobRequest(invalid), null);
  const jobPlan = { criterionId: "ac-job", modality: "job", status: "planned", flow: "Run and immediately read readiness.", jobRequest };
  assert.deepEqual(normalizePlans([jobPlan]), [jobPlan]);
});

test("normalizePlans requires unique criteria and exact planned/not_testable alternatives", () => {
  assert.deepEqual(normalizePlans(plans), plans);
  assert.equal(normalizePlans([]), null);
  assert.equal(normalizePlans([{ ...plans[0], flow: "", notTestableReason: "no" }]), null);
  assert.equal(normalizePlans([{ ...plans[1], apiRequest: { method: "POST", path: "/health", expectedStatus: 200 } }]), null);
  assert.equal(normalizePlans([plans[0], { ...plans[0], modality: "data" }]), null);
  assert.equal(normalizePlans([{ criterionId: "a", modality: "browser", status: "planned", flow: "x" }]), null);
  assert.equal(normalizePlans([{ ...plans[0], extra: true }]), null);
  assert.equal(normalizePlans([{ ...plans[1], extra: true }]), null);
});

test("normalizeApiRequest permits only closed relative GET/status descriptors", () => {
  assert.deepEqual(normalizeApiRequest(plans[1].apiRequest), plans[1].apiRequest);
  for (const apiRequest of [
    { method: "POST", path: "/health", expectedStatus: 200 },
    { method: "GET", path: "//evil.example.test", expectedStatus: 200 },
    { method: "GET", path: "/health?verbose=1", expectedStatus: 200 },
    { method: "GET", path: "/a/%2e%2e/admin", expectedStatus: 200 },
    { method: "GET", path: "/health%23fragment", expectedStatus: 200 },
    { method: "GET", path: "/health", expectedStatus: 99 },
  ]) assert.equal(normalizeApiRequest(apiRequest), null);
});

test("normalizeUiSteps permits one bounded assertion flow and rejects escape hatches", () => {
  assert.deepEqual(normalizeUiSteps(plans[0].uiSteps), plans[0].uiSteps);
  assert.equal(
    normalizeUiSteps([
      { action: "open", path: " /settings" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "proof" },
    ]),
    null,
  );
  assert.equal(
    normalizeUiSteps([
      { action: "open", path: "//other-host" },
      { action: "expect_text", text: "Saved" },
      { action: "screenshot", label: "proof" },
    ]),
    null,
  );
  assert.equal(
    normalizeUiSteps([
      { action: "open", path: "/settings" },
      { action: "expect_text", text: "Saved" },
      { action: "click", selector: "button" },
      { action: "screenshot", label: "proof" },
    ]),
    null,
  );
  assert.equal(
    normalizeUiSteps([
      { action: "open", path: "/settings" },
      { action: "expect_text", text: "Saved" },
      { action: "expect_text", text: "Saved again" },
      { action: "screenshot", label: "proof" },
    ]),
    null,
  );
});

test("posts exactly eveSessionId and the projected complete plans", async () => {
  const calls = [];
  const result = await planReviewVerification({
    eveSessionId: " eve-1 ",
    jobId: " job/1 ",
    plans,
    env,
    transport: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 201,
        json: async () => ({ ok: true, ignored: "not returned" }),
      };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(
    calls[0].url,
    "https://console.example.com/api/v1/runner/review-jobs/job%2F1/verification-plan",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    eveSessionId: "eve-1",
    plans,
  });
});

test("returns stable degraded results for malformed input, configuration, network, non-2xx, and bad body", async () => {
  assert.equal(
    (
      await planReviewVerification({
        eveSessionId: "",
        jobId: "j",
        plans,
        env,
        transport: null,
      })
    ).reason,
    "bad_request",
  );
  assert.equal(
    (
      await planReviewVerification({
        eveSessionId: "e",
        jobId: "j",
        plans,
        env: {},
        transport: null,
      })
    ).reason,
    "config_missing",
  );
  assert.equal(
    (
      await planReviewVerification({
        eveSessionId: "e",
        jobId: "j",
        plans,
        env,
        transport: async () => {
          throw new Error("offline");
        },
      })
    ).reason,
    "unreachable",
  );
  const malformed = await planReviewVerification({
    eveSessionId: "e",
    jobId: "j",
    plans,
    env,
    transport: async () => ({ status: 400, json: async () => ({}) }),
  });
  assert.equal(malformed.reason, "bad_request");
  assert.equal(malformed.status, 400);
  const context = await planReviewVerification({
    eveSessionId: "e",
    jobId: "j",
    plans,
    env,
    transport: async () => ({ status: 409, json: async () => ({}) }),
  });
  assert.equal(context.reason, "review_context");
  assert.equal(context.status, 409);
  const non2xx = await planReviewVerification({
    eveSessionId: "e",
    jobId: "j",
    plans,
    env,
    transport: async () => ({ status: 500, json: async () => ({}) }),
  });
  assert.equal(non2xx.reason, "request_failed");
  assert.equal(non2xx.status, 500);
  assert.equal(
    (
      await planReviewVerification({
        eveSessionId: "e",
        jobId: "j",
        plans,
        env,
        transport: async () => ({
          status: 200,
          json: async () => ({ accepted: true }),
        }),
      })
    ).reason,
    "bad_body",
  );
});
