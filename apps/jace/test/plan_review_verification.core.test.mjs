import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationPlanUrl,
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
  { criterionId: "ac-api", modality: "api", status: "not_testable", notTestableReason: "The API executor is not available in the UI-only R7.2 slice." },
];

test("buildVerificationPlanUrl encodes the server-bound job id", () => {
  assert.equal(
    buildVerificationPlanUrl("https://console.example.com", "job/a b"),
    "https://console.example.com/api/v1/runner/review-jobs/job%2Fa%20b/verification-plan",
  );
});

test("normalizePlans requires unique criteria and exact planned/not_testable alternatives", () => {
  assert.deepEqual(normalizePlans(plans), plans);
  assert.equal(normalizePlans([]), null);
  assert.equal(normalizePlans([{ ...plans[0], flow: "", notTestableReason: "no" }]), null);
  assert.equal(normalizePlans([{ ...plans[1], flow: "run it" }]), null);
  assert.equal(normalizePlans([plans[0], { ...plans[0], modality: "data" }]), null);
  assert.equal(normalizePlans([{ criterionId: "a", modality: "browser", status: "planned", flow: "x" }]), null);
  assert.equal(normalizePlans([{ ...plans[0], extra: true }]), null);
  assert.equal(normalizePlans([{ ...plans[1], extra: true }]), null);
});

test("normalizeUiSteps permits one bounded assertion flow and rejects escape hatches", () => {
  assert.deepEqual(normalizeUiSteps(plans[0].uiSteps), plans[0].uiSteps);
  assert.equal(normalizeUiSteps([
    { action: "open", path: " /settings" },
    { action: "expect_text", text: "Saved" },
    { action: "screenshot", label: "proof" },
  ]), null);
  assert.equal(normalizeUiSteps([
    { action: "open", path: "//other-host" },
    { action: "expect_text", text: "Saved" },
    { action: "screenshot", label: "proof" },
  ]), null);
  assert.equal(normalizeUiSteps([
    { action: "open", path: "/settings" },
    { action: "expect_text", text: "Saved" },
    { action: "click", selector: "button" },
    { action: "screenshot", label: "proof" },
  ]), null);
  assert.equal(normalizeUiSteps([
    { action: "open", path: "/settings" },
    { action: "expect_text", text: "Saved" },
    { action: "expect_text", text: "Saved again" },
    { action: "screenshot", label: "proof" },
  ]), null);
});

test("posts exactly eveSessionId and the projected complete plans", async () => {
  const calls = [];
  const result = await planReviewVerification({
    eveSessionId: " eve-1 ", jobId: " job/1 ", plans,
    env,
    transport: async (url, init) => {
      calls.push({ url, init });
      return { status: 201, json: async () => ({ ok: true, ignored: "not returned" }) };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "https://console.example.com/api/v1/runner/review-jobs/job%2F1/verification-plan");
  assert.deepEqual(JSON.parse(calls[0].init.body), { eveSessionId: "eve-1", plans });
});

test("returns stable degraded results for malformed input, configuration, network, non-2xx, and bad body", async () => {
  assert.equal((await planReviewVerification({ eveSessionId: "", jobId: "j", plans, env, transport: null })).reason, "bad_request");
  assert.equal((await planReviewVerification({ eveSessionId: "e", jobId: "j", plans, env: {}, transport: null })).reason, "config_missing");
  assert.equal((await planReviewVerification({ eveSessionId: "e", jobId: "j", plans, env, transport: async () => { throw new Error("offline"); } })).reason, "unreachable");
  const malformed = await planReviewVerification({ eveSessionId: "e", jobId: "j", plans, env, transport: async () => ({ status: 400, json: async () => ({}) }) });
  assert.equal(malformed.reason, "bad_request"); assert.equal(malformed.status, 400);
  const context = await planReviewVerification({ eveSessionId: "e", jobId: "j", plans, env, transport: async () => ({ status: 409, json: async () => ({}) }) });
  assert.equal(context.reason, "review_context"); assert.equal(context.status, 409);
  const non2xx = await planReviewVerification({ eveSessionId: "e", jobId: "j", plans, env, transport: async () => ({ status: 500, json: async () => ({}) }) });
  assert.equal(non2xx.reason, "request_failed"); assert.equal(non2xx.status, 500);
  assert.equal((await planReviewVerification({ eveSessionId: "e", jobId: "j", plans, env, transport: async () => ({ status: 200, json: async () => ({ accepted: true }) }) })).reason, "bad_body");
});
