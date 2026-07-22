// Unit tests for the post_pr_review core (Jace's sixth gated write action).
// No SDK, no live network: the single HTTP call is an injected `transport`
// seam, so every branch — success and each degraded outcome — is exercised
// deterministically. Mirrors the fakeTransport pattern from
// fetch_run_evidence.core.test.mjs:28-36.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PR_REVIEW_PATH,
  SUMMARY_MAX_LEN,
  COMMENT_BODY_MAX_LEN,
  resolveConsoleConfig,
  buildPrReviewUrl,
  classifyStatus,
  failure,
  sanitizeReviewInput,
  runPostPrReview,
} from "../agent/lib/post_pr_review.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

const VALID_ARGS = {
  eveSessionId: "eve-session-1",
  repo: "ada/widgets",
  prNumber: 98,
  summary: "Looks good overall.",
  comments: [{ path: "src/index.ts", line: 12, body: "Consider a null check here." }],
};

// A fake transport that records how many times it was called and with what,
// so we can assert single-attempt (no-retry) behaviour and request shape.
function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function successBody(overrides = {}) {
  return {
    posted: true,
    reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    summary: "Looks good overall.",
    inlineCommentsPosted: 1,
    foldedComments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildPrReviewUrl / classifyStatus / failure
// ---------------------------------------------------------------------------

test("resolveConsoleConfig resolves + trims + de-slashes when both vars are set", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
    JACE_CONSOLE_TOKEN: "  tok  ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
});

test("resolveConsoleConfig reports exactly which vars are missing", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://c" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

test("buildPrReviewUrl joins the base url and the pr-review path", () => {
  assert.equal(buildPrReviewUrl("https://c.example.com"), `https://c.example.com${PR_REVIEW_PATH}`);
  assert.equal(PR_REVIEW_PATH, "/api/v1/runner/pr-review");
});

test("classifyStatus maps HTTP status to outcome (2xx ok, rest degraded reasons)", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(201), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(409), { ok: false, reason: "conflict" });
  assert.deepEqual(classifyStatus(422), { ok: false, reason: "unprocessable" });
  assert.deepEqual(classifyStatus(429), { ok: false, reason: "rate_limited" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("failure() carries a stable reason + a non-empty message, falling back to a generic message for an unknown reason", () => {
  const f = failure("not_found");
  assert.equal(f.ok, false);
  assert.equal(f.reason, "not_found");
  assert.equal(typeof f.message, "string");
  assert.ok(f.message.length > 0);

  const withOverride = failure("not_found", "custom console message");
  assert.equal(withOverride.message, "custom console message");

  const unknown = failure("who_knows");
  assert.equal(typeof unknown.message, "string");
  assert.ok(unknown.message.length > 0);
});

// ---------------------------------------------------------------------------
// sanitizeReviewInput
// ---------------------------------------------------------------------------

test("sanitizeReviewInput hardens the summary and every comment body, and coerces line to a number", () => {
  const result = sanitizeReviewInput("hello​world", [
    { path: "a.ts", line: "12", body: "javascript:alert(1)" },
  ]);
  assert.equal(result.summary, "helloworld"); // zero-width space stripped
  assert.equal(result.comments[0].path, "a.ts");
  assert.equal(result.comments[0].line, 12);
  assert.match(result.comments[0].body, /javascript\[:\]alert\(1\)/);
});

test("sanitizeReviewInput caps summary and comment body length", () => {
  const result = sanitizeReviewInput("x".repeat(SUMMARY_MAX_LEN + 500), [
    { path: "a.ts", line: 1, body: "y".repeat(COMMENT_BODY_MAX_LEN + 500) },
  ]);
  assert.ok(Array.from(result.summary).length <= SUMMARY_MAX_LEN + 1); // +1 for ellipsis char
  assert.ok(Array.from(result.comments[0].body).length <= COMMENT_BODY_MAX_LEN + 1);
});

test("sanitizeReviewInput tolerates a non-array comments and missing fields without throwing", () => {
  assert.deepEqual(sanitizeReviewInput("hi", undefined), { summary: "hi", comments: [] });
  assert.deepEqual(sanitizeReviewInput("hi", null), { summary: "hi", comments: [] });
  const result = sanitizeReviewInput("hi", [{}]);
  assert.equal(result.comments[0].path, "");
  assert.equal(result.comments[0].body, "");
});

// ---------------------------------------------------------------------------
// runPostPrReview — happy path
// ---------------------------------------------------------------------------

test("runPostPrReview posts { eveSessionId, repo, prNumber, summary, comments } with bearer + JSON headers, and returns the posted shape on 2xx", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));

  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });

  assert.deepEqual(result, {
    ok: true,
    reviewUrl: "https://github.com/ada/widgets/pull/98#pullrequestreview-1",
    summary: "Looks good overall.",
    inlineCommentsPosted: 1,
    foldedComments: [],
  });

  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.equal(url, `https://console.example.com${PR_REVIEW_PATH}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), {
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 98,
    summary: "Looks good overall.",
    comments: [{ path: "src/index.ts", line: 12, body: "Consider a null check here." }],
  });
});

test("runPostPrReview accepts an empty summary when comments are present", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => successBody({ summary: "" }),
  }));

  const result = await runPostPrReview({ ...VALID_ARGS, summary: "", env: ENV, transport });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(transport.calls[0].init.body).comments, VALID_ARGS.comments);
});

test("runPostPrReview reports the console's own reviewUrl/summary/inlineCommentsPosted/foldedComments verbatim", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () =>
      successBody({
        summary: "Looks good overall.\n\n---\nfolded stuff",
        inlineCommentsPosted: 0,
        foldedComments: [{ path: "src/index.ts", line: 12, body: "Consider a null check here." }],
      }),
  }));

  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });

  assert.equal(result.inlineCommentsPosted, 0);
  assert.deepEqual(result.foldedComments, [
    { path: "src/index.ts", line: 12, body: "Consider a null check here." },
  ]);
  assert.match(result.summary, /folded stuff/);
});

// ---------------------------------------------------------------------------
// runPostPrReview — degraded branches, never throws
// ---------------------------------------------------------------------------

test("failure(config_missing) when the console config is unset — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));
  const result = await runPostPrReview({ ...VALID_ARGS, env: {}, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config_missing");
  assert.equal(transport.calls.length, 0);
});

test("failure(bad_request) on a blank eveSessionId/repo, or a non-positive-integer prNumber — no wasted call", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));

  for (const bad of [
    { ...VALID_ARGS, eveSessionId: "  " },
    { ...VALID_ARGS, repo: "" },
    { ...VALID_ARGS, prNumber: 0 },
    { ...VALID_ARGS, prNumber: -1 },
    { ...VALID_ARGS, prNumber: 1.5 },
    { ...VALID_ARGS, prNumber: NaN },
  ]) {
    const result = await runPostPrReview({ ...bad, env: ENV, transport });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("failure(unreachable) when the transport throws — one attempt, no retry, no leaked detail", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("degraded branches: 401/403/404/422/500 each map to a clean structured error, never throw", async () => {
  const cases = [
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "unprocessable"],
    [429, "rate_limited"],
    [500, "upstream_error"],
  ];
  for (const [status, reason] of cases) {
    const transport = fakeTransport(() => ({ status, json: async () => ({ error: "console said no" }) }));
    const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
    assert.equal(result.ok, false, `status ${status}`);
    assert.equal(result.reason, reason, `status ${status} -> ${reason}`);
    assert.equal(result.message, "console said no");
    assert.equal(transport.calls.length, 1);
    // The bearer token must never ride out in a degraded result.
    assert.doesNotMatch(JSON.stringify(result), /tok-secret-123/);
  }
});

test("degraded branches fall back to a generic message when the console's error body is malformed or missing", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "upstream_error");
  assert.ok(result.message.length > 0);
});

test("degraded branches fall back to a generic message when the console's error body is not JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 404,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
  assert.ok(result.message.length > 0);
});

test("failure(bad_body) when the console responds 2xx with non-JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 201,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_body");
});

test("failure(bad_body) when the console responds 2xx but posted is not true", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => ({ posted: false }) }));
  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad_body");
});

test("a thrown transport error never leaks the bearer token even when the thrown message names it", async () => {
  const transport = fakeTransport(() => {
    throw new Error("request to https://console.example.com failed, Authorization: Bearer tok-secret-123");
  });
  const result = await runPostPrReview({ ...VALID_ARGS, env: ENV, transport });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.doesNotMatch(JSON.stringify(result), /tok-secret-123/);
});
