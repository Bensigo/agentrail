// Unit tests for root's fetch_issue core (no SDK, no live network). The
// single HTTP call is an injected `transport` seam — mirrors
// fetch_pr_diff.core.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUE_PATH,
  resolveConsoleConfig,
  buildIssueUrl,
  classifyStatus,
  degraded,
  fetchIssue,
} from "../agent/lib/fetch_issue.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function issueBody(overrides = {}) {
  return {
    number: 42,
    title: "Widgets must persist",
    body: "## Acceptance criteria\n- [ ] AC1: widgets persist across restarts",
    state: "open",
    bodyTruncated: false,
    ...overrides,
  };
}

test("ISSUE_PATH is the runner issue endpoint", () => {
  assert.equal(ISSUE_PATH, "/api/v1/runner/issue");
});

test("buildIssueUrl encodes eveSessionId, repo, and issueNumber", () => {
  const url = buildIssueUrl("https://console.example.com", "eve-1", "ada/widgets", 42);
  assert.equal(
    url,
    "https://console.example.com/api/v1/runner/issue?eveSessionId=eve-1&repo=ada%2Fwidgets&issueNumber=42",
  );
});

test("success passes the issue through with coercion defaults", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => issueBody() }));
  const result = await fetchIssue({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42, transport,
  });
  assert.equal(result.ok, true);
  assert.equal(result.number, 42);
  assert.equal(result.title, "Widgets must persist");
  assert.match(result.body, /AC1: widgets persist/);
  assert.equal(result.state, "open");
  assert.equal(result.bodyTruncated, false);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
});

test("malformed fields coerce, never throw", async () => {
  const transport = fakeTransport(async () => ({
    status: 200,
    json: async () => ({ number: "42", title: null, body: 7, state: null, bodyTruncated: "yes" }),
  }));
  const result = await fetchIssue({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42, transport,
  });
  assert.equal(result.ok, true);
  assert.equal(result.number, 42);       // falls back to the requested number
  assert.equal(result.title, "");
  assert.equal(result.body, "");
  assert.equal(result.state, "");
  assert.equal(result.bodyTruncated, false);
});

test("blank eveSessionId/repo or non-positive issueNumber -> degraded bad_request, no call", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => issueBody() }));
  for (const args of [
    { eveSessionId: "", repo: "ada/widgets", issueNumber: 42 },
    { eveSessionId: "eve-1", repo: "  ", issueNumber: 42 },
    { eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 0 },
    { eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 1.5 },
  ]) {
    const result = await fetchIssue({ env: ENV, transport, ...args });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("unset config -> degraded config_missing with the missing var names", async () => {
  const result = await fetchIssue({
    env: {}, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42,
    transport: fakeTransport(async () => ({ status: 200, json: async () => ({}) })),
  });
  assert.equal(result.reason, "config_missing");
  assert.deepEqual(result.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
});

test("transport throw -> degraded unreachable (single attempt, no retry)", async () => {
  const transport = fakeTransport(async () => { throw new Error("boom"); });
  const result = await fetchIssue({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42, transport,
  });
  assert.equal(result.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
});

test("statuses classify: 400/401/403/404/409/429/5xx/teapot", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.equal(classifyStatus(400).reason, "bad_request");
  assert.equal(classifyStatus(401).reason, "unauthorized");
  assert.equal(classifyStatus(403).reason, "unauthorized");
  assert.equal(classifyStatus(404).reason, "not_found");
  assert.equal(classifyStatus(409).reason, "conflict");
  assert.equal(classifyStatus(429).reason, "rate_limited");
  assert.equal(classifyStatus(500).reason, "upstream_error");
  assert.equal(classifyStatus(418).reason, "unexpected_status");
});

test("non-2xx -> degraded with the mapped reason and status", async () => {
  const transport = fakeTransport(async () => ({ status: 404, json: async () => ({}) }));
  const result = await fetchIssue({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42, transport,
  });
  assert.equal(result.reason, "not_found");
  assert.equal(result.status, 404);
  assert.match(result.note, /pull request/); // the note names the PR-number possibility
});

test("non-JSON body -> degraded bad_body", async () => {
  const transport = fakeTransport(async () => ({ status: 200, json: async () => { throw new Error("nope"); } }));
  const result = await fetchIssue({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42, transport,
  });
  assert.equal(result.reason, "bad_body");
});

test("degraded results never carry free-form transport error text", async () => {
  const transport = fakeTransport(async () => { throw new Error("SECRET-LEAK"); });
  const result = await fetchIssue({
    env: ENV, eveSessionId: "eve-1", repo: "ada/widgets", issueNumber: 42, transport,
  });
  assert.equal(JSON.stringify(result).includes("SECRET-LEAK"), false);
});
