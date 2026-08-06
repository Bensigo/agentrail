import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewerSuppressionsUrl,
  reviewerSuppressions,
} from "../legacy/reviewer/lib/reviewer_suppressions.core.mjs";

test("buildReviewerSuppressionsUrl uses the configured runner route and query params", () => {
  assert.equal(
    buildReviewerSuppressionsUrl("https://console.test", "eve-1", "acme/widgets"),
    "https://console.test/api/v1/runner/reviewer-suppressions?eveSessionId=eve-1&repo=acme%2Fwidgets",
  );
});

test("reviewerSuppressions returns normalized rules from the console", async () => {
  const result = await reviewerSuppressions({
    env: {
      JACE_CONSOLE_BASE_URL: "https://console.test/",
      JACE_CONSOLE_TOKEN: "secret",
    },
    eveSessionId: "eve-1",
    repo: "acme/widgets",
    transport: async () => ({
      status: 200,
      json: async () => ({
        repo: "acme/widgets",
        degraded: null,
        rules: [{
          findingClass: "  Legacy Auth False Positive ",
          count: 3,
          reason: "",
          sourceEventIds: [" event-a ", "event-b", "event-c"],
        }],
      }),
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    degraded: false,
    repo: "acme/widgets",
    rules: [{
      findingClass: "legacy auth false positive",
      count: 3,
      reason:
        '3 prior review findings with class "legacy auth false positive" were dismissed for this repo.',
      sourceEventIds: ["event-a", "event-b", "event-c"],
    }],
  });
});

test("reviewerSuppressions degrades every route failure to no rules", async () => {
  const result = await reviewerSuppressions({
    env: {
      JACE_CONSOLE_BASE_URL: "https://console.test",
      JACE_CONSOLE_TOKEN: "secret",
    },
    eveSessionId: "eve-1",
    repo: "acme/widgets",
    transport: async () => ({
      status: 500,
      json: async () => ({ error: "db down" }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.reason, "upstream_error");
  assert.deepEqual(result.rules, []);
});

test("reviewerSuppressions treats route-degraded storage as no suppression", async () => {
  const result = await reviewerSuppressions({
    env: {
      JACE_CONSOLE_BASE_URL: "https://console.test",
      JACE_CONSOLE_TOKEN: "secret",
    },
    eveSessionId: "eve-1",
    repo: "acme/widgets",
    transport: async () => ({
      status: 200,
      json: async () => ({
        repo: "acme/widgets",
        degraded: { reason: "storage_error" },
        rules: [],
      }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.reason, "route_degraded");
  assert.deepEqual(result.rules, []);
});
