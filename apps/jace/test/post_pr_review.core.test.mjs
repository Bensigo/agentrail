// Unit tests for the post_pr_review core (Jace's advisory, UNGATED PR-review
// write path). No SDK, no live network: the single HTTP call is an injected
// `transport` seam, so every branch — success and each degraded outcome — is
// exercised deterministically. Mirrors the fakeTransport pattern from
// fetch_run_evidence.core.test.mjs:28-36.
//
// The severity filter below is the control that REPLACED the human approval
// gate (see the core module's own doc-comment): with no human reading the
// exact call before it lands on GitHub, "only blockers and majors get posted"
// has to be enforced in code, not asked for in a prompt.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PR_REVIEW_PATH,
  SUMMARY_MAX_LEN,
  COMMENT_BODY_MAX_LEN,
  POSTABLE_SEVERITIES,
  resolveConsoleConfig,
  buildPrReviewUrl,
  classifyStatus,
  failure,
  filterPostableComments,
  sanitizeReviewInput,
  runPostPrReview,
  renderAcCoverage,
  coverageCounts,
  composeSummaryWithCoverage,
  renderJudgmentLine,
  composeSummary,
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
  comments: [
    { path: "src/index.ts", line: 12, severity: "blocker", body: "Consider a null check here." },
  ],
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

// A well-formed acCoverage entry (Task 3's REVIEW_SCHEMA shape), for the
// renderAcCoverage / coverageCounts / composeSummaryWithCoverage tests below.
function acEntry(overrides = {}) {
  return {
    issueNumber: 42,
    criterion: "AC1: widgets persist across restarts",
    status: "addressed",
    evidence: "persistence write added in src/store.ts",
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
    droppedComments: 0,
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
  // `severity` is an internal control (see filterPostableComments) and is
  // stripped before the call — the console/GitHub contract is {path,line,body}.
  assert.deepEqual(
    JSON.parse(transport.calls[0].init.body).comments,
    VALID_ARGS.comments.map(({ severity: _severity, ...rest }) => rest),
  );
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

// ---------------------------------------------------------------------------
// filterPostableComments — the severity gate that replaced the human gate
// ---------------------------------------------------------------------------

test("POSTABLE_SEVERITIES is exactly blocker + major — minor and nit are never posted", () => {
  assert.deepEqual([...POSTABLE_SEVERITIES].sort(), ["blocker", "major"]);
});

test("filterPostableComments keeps blocker + major and drops minor + nit", () => {
  const { postable, dropped } = filterPostableComments([
    { path: "a.ts", line: 1, severity: "blocker", body: "b" },
    { path: "b.ts", line: 2, severity: "minor", body: "m" },
    { path: "c.ts", line: 3, severity: "major", body: "M" },
    { path: "d.ts", line: 4, severity: "nit", body: "n" },
  ]);
  assert.deepEqual(
    postable.map((c) => c.path),
    ["a.ts", "c.ts"],
  );
  assert.equal(dropped, 2);
});

test("filterPostableComments drops a comment with a missing/unknown severity rather than posting it", () => {
  // Fail CLOSED: with no human reading the call, an unlabelled comment is a
  // comment we cannot prove the owner wanted posted.
  const { postable, dropped } = filterPostableComments([
    { path: "a.ts", line: 1, body: "no severity at all" },
    { path: "b.ts", line: 2, severity: "critical", body: "not one of ours" },
    { path: "c.ts", line: 3, severity: null, body: "explicitly null" },
  ]);
  assert.deepEqual(postable, []);
  assert.equal(dropped, 3);
});

test("filterPostableComments is case- and whitespace-tolerant on severity", () => {
  const { postable, dropped } = filterPostableComments([
    { path: "a.ts", line: 1, severity: "  BLOCKER ", body: "b" },
    { path: "b.ts", line: 2, severity: "Major", body: "M" },
  ]);
  assert.equal(postable.length, 2);
  assert.equal(dropped, 0);
});

test("filterPostableComments tolerates a non-array without throwing", () => {
  assert.deepEqual(filterPostableComments(undefined), { postable: [], dropped: 0 });
  assert.deepEqual(filterPostableComments("nope"), { postable: [], dropped: 0 });
});

test("runPostPrReview posts ONLY blocker+major comments and reports how many it dropped", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ inlineCommentsPosted: 1 }),
  }));
  const result = await runPostPrReview({
    ...VALID_ARGS,
    comments: [
      { path: "a.ts", line: 1, severity: "blocker", body: "real bug" },
      { path: "b.ts", line: 2, severity: "minor", body: "style thing" },
      { path: "c.ts", line: 3, severity: "nit", body: "trailing comma" },
    ],
    env: ENV,
    transport,
  });

  assert.equal(result.ok, true);
  assert.equal(result.droppedComments, 2);

  const sent = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(
    sent.comments.map((c) => c.path),
    ["a.ts"],
  );
  // The severity label is an internal control, not part of the console/GitHub
  // contract — it must not ride along in the posted payload.
  assert.ok(!("severity" in sent.comments[0]), "severity must not be sent to the console");
});

test("runPostPrReview still posts the summary when every finding was minor/nit", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ inlineCommentsPosted: 0 }),
  }));
  const result = await runPostPrReview({
    ...VALID_ARGS,
    summary: "Read the diff; nothing blocking.",
    comments: [{ path: "a.ts", line: 1, severity: "nit", body: "spacing" }],
    env: ENV,
    transport,
  });

  assert.equal(result.ok, true);
  assert.equal(result.droppedComments, 1);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sent.comments, []);
  assert.equal(sent.summary, "Read the diff; nothing blocking.");
});

test("failure(nothing_to_post) when the summary is blank and every comment was filtered out — no wasted call", async () => {
  const transport = fakeTransport(async () => {
    throw new Error("must not be called");
  });
  const result = await runPostPrReview({
    ...VALID_ARGS,
    summary: "   ",
    comments: [{ path: "a.ts", line: 1, severity: "minor", body: "style thing" }],
    env: ENV,
    transport,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "nothing_to_post");
  assert.match(result.message, /blocker|major/i);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// renderAcCoverage / coverageCounts / composeSummaryWithCoverage — the
// per-AC coverage checklist rendered into the posted summary
// ---------------------------------------------------------------------------

test("renderAcCoverage: issue groups sort ascending, PR-description group renders last", () => {
  const block = renderAcCoverage([
    acEntry({ issueNumber: null, criterion: "AC3: self-stated", status: "unclear", evidence: "" }),
    acEntry({ issueNumber: 43, criterion: "AC2: flag surfaced", status: "not_in_diff", evidence: "" }),
    acEntry(),
  ]);
  const idx42 = block.indexOf("**Acceptance criteria — issue #42:**");
  const idx43 = block.indexOf("**Acceptance criteria — issue #43:**");
  const idxPr = block.indexOf("**Acceptance criteria — from the PR description:**");
  assert.ok(idx42 !== -1 && idx43 !== -1 && idxPr !== -1);
  assert.ok(idx42 < idx43 && idx43 < idxPr);
  assert.ok(block.includes("- ✅ AC1: widgets persist across restarts — persistence write added in src/store.ts"));
  assert.ok(block.includes("- ❌ AC2: flag surfaced — not visibly addressed in this diff"));
  assert.ok(block.includes("- ❓ AC3: self-stated — can't tell from the diff"));
});

test("renderAcCoverage: empty, null, and malformed-entry inputs render nothing", () => {
  assert.equal(renderAcCoverage(null), "");
  assert.equal(renderAcCoverage([]), "");
  assert.equal(renderAcCoverage([{ status: "bogus", criterion: "x" }, { criterion: "" }]), "");
});

test("composeSummaryWithCoverage appends the block under the summary", () => {
  const out = composeSummaryWithCoverage("Solid PR overall.", [acEntry()]);
  assert.ok(out.startsWith("Solid PR overall."));
  assert.ok(out.includes("**Acceptance criteria — issue #42:**"));
});

test("composeSummaryWithCoverage folds to the count line when the block would blow SUMMARY_MAX_LEN", () => {
  const bigSummary = "s".repeat(SUMMARY_MAX_LEN - 40);
  const entries = [
    acEntry(),
    acEntry({ criterion: "AC2: another", status: "not_in_diff", evidence: "" }),
    acEntry({ criterion: "AC3: third", status: "unclear", evidence: "" }),
  ];
  const out = composeSummaryWithCoverage(bigSummary, entries);
  assert.ok(!out.includes("**Acceptance criteria"));
  assert.ok(out.includes("AC coverage: 1/3 addressed, 1 not in diff, 1 unclear — details in chat."));
});

test("runPostPrReview sends the composed summary (with the coverage block) to the console", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ posted: true, reviewUrl: "https://github.com/r", summary: "x", inlineCommentsPosted: 0, foldedComments: [] }),
  }));
  const result = await runPostPrReview({
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: "Solid PR overall.",
    comments: [],
    acCoverage: [acEntry()],
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.ok(sent.summary.includes("**Acceptance criteria — issue #42:**"));
  assert.ok(sent.summary.includes("✅"));
});

test("omitting acCoverage leaves the posted body byte-identical to today's", async () => {
  const respond = async () => ({
    status: 201,
    json: async () => ({ posted: true, reviewUrl: null, summary: "x", inlineCommentsPosted: 0, foldedComments: [] }),
  });
  const t1 = fakeTransport(respond);
  const t2 = fakeTransport(respond);
  const args = {
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: "Solid PR overall.",
    comments: [],
    env: ENV,
  };
  await runPostPrReview({ ...args, transport: t1 });
  await runPostPrReview({ ...args, acCoverage: null, transport: t2 });
  assert.equal(t1.calls[0].init.body, t2.calls[0].init.body);
});

test("coverage criterion text is hardened before it leaves (no zero-width smuggling, @everyone defanged)", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ posted: true, reviewUrl: null, summary: "x", inlineCommentsPosted: 0, foldedComments: [] }),
  }));
  await runPostPrReview({
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: "ok",
    comments: [],
    acCoverage: [acEntry({ criterion: "AC1: do​thing @everyone" })],
    env: ENV,
    transport,
  });
  const sent = JSON.parse(transport.calls[0].init.body);
  // hardenUntrusted DELETES zero-width space (U+200B) outright — it's not
  // replaced with anything, so the raw code point must not survive.
  assert.ok(!sent.summary.includes("​"));
  // hardenUntrusted defangs mass mentions by swapping the ASCII "@" for a
  // fullwidth "＠" (U+FF20) — "@everyone" becomes "＠everyone", so the
  // literal ASCII string must no longer appear, though the (now-inert) word
  // "everyone" still does.
  assert.ok(!sent.summary.includes("@everyone"));
  assert.ok(sent.summary.includes("＠everyone"));
});

test("a coverage-only review (blank summary, no comments) still posts — composeSummaryWithCoverage feeds the nothing_to_post gate", async () => {
  const transport = fakeTransport(() => ({ status: 201, json: async () => successBody() }));
  const result = await runPostPrReview({
    ...VALID_ARGS,
    summary: "",
    comments: [],
    acCoverage: [acEntry()],
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  assert.equal(transport.calls.length, 1);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.ok(sent.summary.includes("**Acceptance criteria — issue #42:**"));
});

test("renderAcCoverage: addressed with empty evidence has no trailing em-dash", () => {
  const block = renderAcCoverage([acEntry({ evidence: "" })]);
  assert.ok(block.includes("- ✅ AC1: widgets persist across restarts"));
  assert.ok(!block.includes("restarts —"));
});

test("renderAcCoverage: criterion and evidence are trimmed before rendering", () => {
  const block = renderAcCoverage([acEntry({ criterion: "  AC1: x  ", evidence: "  y  " })]);
  assert.ok(block.includes("- ✅ AC1: x — y"));
});

test("runPostPrReview: the coverage fold path is visible in what's actually sent over the wire", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ summary: "x" }),
  }));
  const bigSummary = "s".repeat(SUMMARY_MAX_LEN - 40);
  const entries = [
    acEntry(),
    acEntry({ criterion: "AC2: another", status: "not_in_diff", evidence: "" }),
    acEntry({ criterion: "AC3: third", status: "unclear", evidence: "" }),
  ];
  const result = await runPostPrReview({
    ...VALID_ARGS,
    summary: bigSummary,
    comments: [],
    acCoverage: entries,
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.ok(sent.summary.includes("AC coverage: 1/3 addressed, 1 not in diff, 1 unclear — details in chat."));
  assert.ok(!sent.summary.includes("**Acceptance criteria"));
});

test("runPostPrReview: a pathological base (already within a hair of the cap) still lets the count line survive whole — the base cedes its tail instead", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ summary: "x" }),
  }));
  // Only 10 chars of headroom under SUMMARY_MAX_LEN — even the count line
  // alone (~71 chars) cannot fit alongside the base unmodified, so this
  // forces composeSummaryWithCoverage's base-cedes-its-tail branch.
  const bigSummary = "s".repeat(SUMMARY_MAX_LEN - 10);
  const entries = [
    acEntry(),
    acEntry({ criterion: "AC2: another", status: "not_in_diff", evidence: "" }),
    acEntry({ criterion: "AC3: third", status: "unclear", evidence: "" }),
  ];
  const result = await runPostPrReview({
    ...VALID_ARGS,
    summary: bigSummary,
    comments: [],
    acCoverage: entries,
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  const sent = JSON.parse(transport.calls[0].init.body);
  // The count line rides out whole — never truncated, regardless of how
  // little room the base left for it.
  assert.ok(sent.summary.includes("AC coverage: 1/3 addressed, 1 not in diff, 1 unclear — details in chat."));
  assert.ok(sent.summary.length <= SUMMARY_MAX_LEN);
  // The base visibly ceded its own tail instead.
  assert.ok(sent.summary.includes("…"));
});

// ---------------------------------------------------------------------------
// renderJudgmentLine / composeSummary — Task 8: the judgment line rendered
// from Task 6's judgment shape, plus the deterministic fold cascade that
// keeps the coverage count line AND the judgment line whole under
// SUMMARY_MAX_LEN even in the double-pathological case.
// ---------------------------------------------------------------------------

// The exact short fallback line composeSummary folds the judgment down to —
// kept as one constant so every assertion below matches the implementation
// character-for-character (including the em dash).
const SHORT_JUDGMENT_LINE = "**Judgment:** 4 verdicts — details in chat.";

// A well-formed judgment (Task 6's shape / reviewer.core.mjs's
// JUDGMENT_VERDICTS): all four fields on their least-alarming verdict by
// default, overridable per field per test.
function judgment(overrides = {}) {
  return {
    simplest: { verdict: "yes", note: "", basis: [] },
    architecture: { verdict: "consistent", note: "", basis: [] },
    debt: { verdict: "none_found", note: "", basis: [] },
    hiddenRisks: { verdict: "none_found", note: "", basis: [] },
    ...overrides,
  };
}

test("renderJudgmentLine: all-positive verdicts render one compact line, no notes/basis attached", () => {
  const line = renderJudgmentLine(judgment());
  assert.equal(
    line,
    "**Judgment:** simplest: yes · architecture: consistent · debt: none found · hidden risks: none found",
  );
});

test("renderJudgmentLine: a negative verdict carries its note and basis ids; positive fields do not", () => {
  const line = renderJudgmentLine(
    judgment({
      simplest: {
        verdict: "no",
        note: "A three-line helper already does this in src/util.ts.",
        basis: ["i1", "i2"],
      },
    }),
  );
  assert.equal(
    line,
    "**Judgment:** simplest: no — A three-line helper already does this in src/util.ts. (i1, i2) · " +
      "architecture: consistent · debt: none found · hidden risks: none found",
  );
});

test("renderJudgmentLine: a negative verdict's note is capped at 200 chars with a trailing ellipsis", () => {
  const longNote = "n".repeat(250);
  const line = renderJudgmentLine(
    judgment({ debt: { verdict: "introduces", note: longNote, basis: ["i1"] } }),
  );
  assert.ok(line.includes(`${"n".repeat(200)}…`));
  assert.ok(!line.includes("n".repeat(201)));
  assert.ok(line.includes(`debt: introduces — ${"n".repeat(200)}… (i1)`));
});

test("renderJudgmentLine: null, undefined, a non-object, an array, or an all-empty object all render \"\"", () => {
  assert.equal(renderJudgmentLine(null), "");
  assert.equal(renderJudgmentLine(undefined), "");
  assert.equal(renderJudgmentLine("nope"), "");
  assert.equal(renderJudgmentLine([]), "");
  assert.equal(renderJudgmentLine({}), "");
});

test("renderJudgmentLine: a field with an unrecognized verdict is skipped, not rendered as garbage", () => {
  const line = renderJudgmentLine(judgment({ architecture: { verdict: "bogus_verdict", note: "", basis: [] } }));
  assert.equal(line, "**Judgment:** simplest: yes · debt: none found · hidden risks: none found");
});

test("composeSummary: null/omitted judgment returns exactly composeSummaryWithCoverage's output — no cascade, no judgment text", () => {
  const out = composeSummary("Solid PR overall.", [acEntry()], null);
  assert.equal(out, composeSummaryWithCoverage("Solid PR overall.", [acEntry()]));
  assert.ok(!out.includes("Judgment"));
});

test("composeSummary: full composition (summary + judgment line) when everything fits under the cap", () => {
  const out = composeSummary("Solid PR overall.", null, judgment());
  assert.equal(
    out,
    "Solid PR overall.\n\n**Judgment:** simplest: yes · architecture: consistent · debt: none found · hidden risks: none found",
  );
});

test("composeSummary: the (unfolded) coverage block and the judgment line both ride, coverage first", () => {
  const out = composeSummary("Solid PR overall.", [acEntry()], judgment());
  assert.ok(out.includes("**Acceptance criteria — issue #42:**"));
  assert.ok(out.includes("**Judgment:** simplest: yes"));
  assert.ok(out.indexOf("**Acceptance criteria") < out.indexOf("**Judgment:**"));
});

test("composeSummary: judgment folds to the short line when the full line would blow the cap but the short line still fits", () => {
  const j = judgment();
  const fullLine = renderJudgmentLine(j);
  const sepLen = 2; // withCoverage is non-blank, so sep is "\n\n"
  // Engineered so summary+sep+fullLine overflows but summary+sep+shortLine
  // still fits comfortably (5 chars to spare).
  const summaryLen = SUMMARY_MAX_LEN - sepLen - SHORT_JUDGMENT_LINE.length - 5;
  const summary = "s".repeat(summaryLen);

  // Confirm the engineered lengths actually force the branch we're testing.
  assert.ok(summary.length + sepLen + fullLine.length > SUMMARY_MAX_LEN, "full line must overflow");
  assert.ok(summary.length + sepLen + SHORT_JUDGMENT_LINE.length <= SUMMARY_MAX_LEN, "short line must fit");

  const out = composeSummary(summary, null, j);
  assert.equal(out, `${summary}\n\n${SHORT_JUDGMENT_LINE}`);
  assert.ok(out.length <= SUMMARY_MAX_LEN);
});

test("composeSummary: base cedes its own tail when there is no coverage count line to protect (summary alone already exceeds the cap)", () => {
  const bigSummary = "s".repeat(SUMMARY_MAX_LEN + 500);
  const out = composeSummary(bigSummary, null, judgment());
  assert.ok(out.length <= SUMMARY_MAX_LEN);
  assert.ok(out.endsWith(`\n\n${SHORT_JUDGMENT_LINE}`));
  assert.ok(out.includes("…"));
});

test("composeSummary: double-pathological branch keeps BOTH the AC coverage count line and the short judgment line whole, under the cap", () => {
  // Same engineered setup as the composeSummaryWithCoverage pathological-base
  // test above: bigSummary lands composeSummaryWithCoverage's own fold
  // exactly AT SUMMARY_MAX_LEN, so adding anything at all (even just the
  // separator) forces composeSummary's own cascade all the way to its final,
  // dual-preserving branch.
  const bigSummary = "s".repeat(SUMMARY_MAX_LEN - 10);
  const entries = [
    acEntry(),
    acEntry({ criterion: "AC2: another", status: "not_in_diff", evidence: "" }),
    acEntry({ criterion: "AC3: third", status: "unclear", evidence: "" }),
  ];
  const withCoverage = composeSummaryWithCoverage(bigSummary, entries);
  assert.equal(withCoverage.length, SUMMARY_MAX_LEN, "sanity: withCoverage must land exactly at the cap");

  const out = composeSummary(bigSummary, entries, judgment());
  assert.ok(out.length <= SUMMARY_MAX_LEN);

  const countLine = "AC coverage: 1/3 addressed, 1 not in diff, 1 unclear — details in chat.";
  const countLineIdx = out.indexOf(countLine);
  const judgmentLineIdx = out.indexOf(SHORT_JUDGMENT_LINE);
  assert.ok(countLineIdx !== -1, "the coverage count line must survive whole");
  assert.ok(judgmentLineIdx !== -1, "the short judgment line must survive whole");
  assert.ok(countLineIdx < judgmentLineIdx);
  // Nothing trails the short judgment line, and nothing but the separator
  // sits between the two guaranteed lines — both rode out whole, back to back.
  assert.equal(out.slice(countLineIdx), `${countLine}\n\n${SHORT_JUDGMENT_LINE}`);
});

test("runPostPrReview sends the judgment line inside the composed summary", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ summary: "x" }),
  }));
  const result = await runPostPrReview({
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: "Solid PR overall.",
    comments: [],
    judgment: judgment({
      debt: { verdict: "introduces", note: "Adds a second cache with no eviction.", basis: ["i3"] },
    }),
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.ok(sent.summary.includes("**Judgment:**"));
  assert.ok(sent.summary.includes("debt: introduces — Adds a second cache with no eviction. (i3)"));
});

test("judgment note text is hardened before it leaves (no zero-width smuggling, @everyone defanged)", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => ({ posted: true, reviewUrl: null, summary: "x", inlineCommentsPosted: 0, foldedComments: [] }),
  }));
  await runPostPrReview({
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: "ok",
    comments: [],
    judgment: judgment({
      architecture: { verdict: "violates", note: "do​thing @everyone", basis: ["i1"] },
    }),
    env: ENV,
    transport,
  });
  const sent = JSON.parse(transport.calls[0].init.body);
  // hardenUntrusted DELETES zero-width space (U+200B) outright.
  assert.ok(!sent.summary.includes("​"));
  // hardenUntrusted defangs mass mentions by swapping the ASCII "@" for a
  // fullwidth "＠" (U+FF20).
  assert.ok(!sent.summary.includes("@everyone"));
  assert.ok(sent.summary.includes("＠everyone"));
});

test("omitting judgment leaves the posted body byte-identical to a call that never knew about judgment", async () => {
  const respond = async () => ({
    status: 201,
    json: async () => ({ posted: true, reviewUrl: null, summary: "x", inlineCommentsPosted: 0, foldedComments: [] }),
  });
  const t1 = fakeTransport(respond);
  const t2 = fakeTransport(respond);
  const args = {
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: "Solid PR overall.",
    comments: [],
    env: ENV,
  };
  await runPostPrReview({ ...args, transport: t1 });
  await runPostPrReview({ ...args, judgment: null, transport: t2 });
  assert.equal(t1.calls[0].init.body, t2.calls[0].init.body);
});

// ---------------------------------------------------------------------------
// composeSummary security fix: the count-line detection inside the
// double-pathological branch must be gated on a coverage block having
// ACTUALLY been rendered from real acCoverage input — never on the "AC
// coverage: " text prefix alone. Without the gate, a model-drafted
// (attacker-steerable) `summary` whose own last line happens to start with
// that literal prefix gets wrongly treated as the guaranteed, protected
// count line: composeSummary's own SUMMARY_MAX_LEN guarantee breaks (the
// "count line" it protects is unbounded), and hardenUntrusted's downstream
// truncation then silently evicts the real guaranteed line — the short
// judgment fallback — off the end. All three regression tests below go
// through the REAL `runPostPrReview` transport capture, not a direct
// `composeSummary` call, so they exercise the exact code path a posted
// review actually takes (compose -> sanitizeReviewInput -> hardenUntrusted).
// ---------------------------------------------------------------------------

test("a spoofed 'AC coverage: ' tail in the summary is NOT granted count-line protection when no coverage was ever rendered — the judgment line survives and the spoofed prefix is truncated like ordinary text", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ summary: "x" }),
  }));
  // The reviewer's exact reproduction: a 9059-char summary whose entire text
  // IS the spoofed line (no real newlines), with acCoverage: null — so no
  // coverage block is ever rendered and nothing here should be protected.
  const spoofedTail = `AC coverage: ${"w".repeat(9046)}`;
  assert.equal(spoofedTail.length, 9059);
  const result = await runPostPrReview({
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: spoofedTail,
    comments: [],
    acCoverage: null,
    judgment: judgment(),
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  const sent = JSON.parse(transport.calls[0].init.body);
  // The guaranteed short judgment line survives — this is exactly what a
  // spoofed, unbounded "count line" would otherwise evict off the end.
  assert.ok(sent.summary.includes(SHORT_JUDGMENT_LINE));
  assert.ok(sent.summary.length <= SUMMARY_MAX_LEN);
  // The spoofed payload was cut down like ordinary text, not preserved whole
  // as an untouchable protected line.
  assert.ok(!sent.summary.includes("w".repeat(9046)));
});

test("a spoofed 'AC coverage: ' line INSIDE a summary that ALSO has real folded coverage does not weaken protection — the genuine count line still survives whole", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ summary: "x" }),
  }));
  // A decoy occurrence of the exact detection prefix, planted at the START
  // of the base text (never the last line) — proving an earlier spoof can't
  // confuse detection of the GENUINE trailing count line that
  // composeSummaryWithCoverage itself produces from real acCoverage input.
  const decoy = "AC coverage: totally fake, ignore the real one — ";
  const bigSummary = `${decoy}${"s".repeat(SUMMARY_MAX_LEN - 10 - decoy.length)}`;
  const entries = [
    acEntry(),
    acEntry({ criterion: "AC2: another", status: "not_in_diff", evidence: "" }),
    acEntry({ criterion: "AC3: third", status: "unclear", evidence: "" }),
  ];
  const result = await runPostPrReview({
    ...VALID_ARGS,
    summary: bigSummary,
    comments: [],
    acCoverage: entries,
    judgment: judgment(),
    env: ENV,
    transport,
  });
  assert.equal(result.ok, true);
  const sent = JSON.parse(transport.calls[0].init.body);
  const realCountLine = "AC coverage: 1/3 addressed, 1 not in diff, 1 unclear — details in chat.";
  assert.ok(sent.summary.length <= SUMMARY_MAX_LEN);
  // The genuine count line rides out whole, immediately followed by the
  // short judgment line — both guaranteed lines, back to back, intact.
  assert.equal(
    sent.summary.slice(sent.summary.indexOf(realCountLine)),
    `${realCountLine}\n\n${SHORT_JUDGMENT_LINE}`,
  );
  // The decoy is present but inert — ordinary surviving text, not a
  // protected line (it was never treated as one).
  assert.ok(sent.summary.includes(decoy));
});

test("composeSummary's output never exceeds SUMMARY_MAX_LEN for the reviewer's exact 9059-char spoofed construction", async () => {
  const transport = fakeTransport(async () => ({
    status: 201,
    json: async () => successBody({ summary: "x" }),
  }));
  const spoofedTail = `AC coverage: ${"w".repeat(9046)}`;
  assert.equal(spoofedTail.length, 9059);
  await runPostPrReview({
    eveSessionId: "eve-session-1",
    repo: "ada/widgets",
    prNumber: 7,
    summary: spoofedTail,
    comments: [],
    acCoverage: null,
    judgment: judgment(),
    env: ENV,
    transport,
  });
  const sent = JSON.parse(transport.calls[0].init.body);
  // hardenUntrusted's own capText is a no-op when already at-or-under its
  // maxLen (SUMMARY_MAX_LEN), so this is equally a direct check on
  // composeSummary's own guarantee, exercised through the real post path.
  assert.ok(sent.summary.length <= SUMMARY_MAX_LEN);
});
