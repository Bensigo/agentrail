// Unit tests for the reviewer subagent's fetch core (no SDK, no live
// network). The single HTTP call is an injected `transport` seam, so every
// branch — success and each degraded outcome — is exercised
// deterministically. Mirrors the fakeTransport pattern from
// fetch_run_evidence.core.test.mjs:28-36.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PR_REVIEW_PATH,
  resolveConsoleConfig,
  buildPrDiffUrl,
  classifyStatus,
  degraded,
  fetchPrDiff,
} from "../agent/subagents/reviewer/lib/fetch_pr_diff.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

// A fake transport that records how many times it was called and with what, so
// we can assert single-attempt (no-retry) behaviour and header shape.
function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function prBody(overrides = {}) {
  return {
    title: "Add widgets",
    author: "ada",
    baseRef: "main",
    headRef: "ada/widgets-branch",
    body: "This adds widgets.",
    changedFiles: [
      { path: "src/index.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1,3 +1,3 @@\n-old\n+new" },
    ],
    truncated: false,
    omittedPaths: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig
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

// ---------------------------------------------------------------------------
// buildPrDiffUrl / classifyStatus
// ---------------------------------------------------------------------------

test("buildPrDiffUrl targets the pr-review route with eveSessionId/repo/prNumber as query params", () => {
  const url = buildPrDiffUrl("https://c.example.com", "eve-1", "ada/widgets", 98);
  assert.equal(
    url,
    `https://c.example.com${PR_REVIEW_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&prNumber=98`,
  );
});

test("classifyStatus maps HTTP status to outcome (2xx ok, rest degraded reasons)", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(409), { ok: false, reason: "conflict" });
  assert.deepEqual(classifyStatus(429), { ok: false, reason: "rate_limited" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded carries a stable reason + cause-free note and no free-form text", () => {
  const d = degraded("unreachable", { status: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "unreachable");
  assert.equal(typeof d.note, "string");
  assert.ok(d.note.length > 0);
  assert.equal(d.status, 0);
  assert.equal(typeof degraded("who_knows").note, "string");
});

// ---------------------------------------------------------------------------
// fetchPrDiff — success
// ---------------------------------------------------------------------------

test("fetchPrDiff returns the PR shape on 200 (ok path), with the bearer + accept headers, exactly one attempt", async () => {
  const body = prBody();
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchPrDiff({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });

  assert.equal(res.ok, true);
  assert.equal(res.repo, "ada/widgets");
  assert.equal(res.prNumber, 98);
  assert.equal(res.title, "Add widgets");
  assert.equal(res.author, "ada");
  assert.equal(res.baseRef, "main");
  assert.equal(res.headRef, "ada/widgets-branch");
  assert.equal(res.body, "This adds widgets.");
  assert.deepEqual(res.changedFiles, body.changedFiles);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.omittedPaths, []);

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls[0].init.headers.Accept, "application/json");
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${PR_REVIEW_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&prNumber=98`,
  );
});

test("fetchPrDiff reports truncated + omittedPaths honestly when the console capped the diff", async () => {
  const body = prBody({ truncated: true, omittedPaths: ["big-lockfile.json"] });
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchPrDiff({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });

  assert.equal(res.truncated, true);
  assert.deepEqual(res.omittedPaths, ["big-lockfile.json"]);
});

test("fetchPrDiff defensively coerces a malformed 2xx body to empty/safe defaults rather than throwing", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const res = await fetchPrDiff({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(res.ok, true);
  assert.equal(res.title, "");
  assert.equal(res.author, "");
  assert.deepEqual(res.changedFiles, []);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.omittedPaths, []);
});

// ---------------------------------------------------------------------------
// fetchPrDiff — degraded outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("degraded(bad_request) on a blank eveSessionId/repo, or a non-positive-integer prNumber, before any transport call", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => prBody() }));

  for (const args of [
    { eveSessionId: "  ", repo: "ada/widgets", prNumber: 98 },
    { eveSessionId: "eve-1", repo: "", prNumber: 98 },
    { eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 0 },
    { eveSessionId: "eve-1", repo: "ada/widgets", prNumber: -1 },
    { eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 1.5 },
  ]) {
    const res = await fetchPrDiff({ env: ENV, ...args, transport });
    assert.equal(res.degraded, true, JSON.stringify(args));
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0); // no wasted calls
});

test("degraded(config_missing) with the missing vars when console is unconfigured", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => prBody() }));
  const res = await fetchPrDiff({ env: {}, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

test("degraded(unreachable) when the transport throws — one attempt, no retry", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchPrDiff({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("degraded maps each non-2xx status and carries the status, without the token", async () => {
  const cases = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "upstream_error"],
    [418, "unexpected_status"],
  ];
  for (const [status, reason] of cases) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const res = await fetchPrDiff({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
    assert.equal(res.degraded, true, `status ${status} must degrade`);
    assert.equal(res.reason, reason, `status ${status} -> ${reason}`);
    assert.equal(res.status, status);
    assert.equal(transport.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
  }
});

test("degraded(bad_body) when the console responds 200 with non-JSON", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await fetchPrDiff({ env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", prNumber: 98, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_body");
  assert.equal(res.status, 200);
});
