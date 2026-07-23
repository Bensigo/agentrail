// Unit tests for the backlog-grooming mutation APPLY core (issue #1291). Pure,
// injected transport — no live console. The human-approval GATE itself lives in
// consoleGatedApproval (exhaustively tested in console_gated_approval.core.test.mjs);
// this core is only ever reached AFTER an approved decision, and these tests
// prove it builds the right wire body per action and never throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMutationBody,
  classifyStatus,
  failure,
  runBacklogMutation,
  buildMutateUrl,
  BACKLOG_MUTATE_PATH,
} from "../agent/lib/backlog_mutation.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

function appliedResponse(extra = {}) {
  return { status: 200, json: async () => ({ applied: true, ...extra }) };
}

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("buildMutateUrl joins the base + path", () => {
  assert.equal(buildMutateUrl("https://console.example.com"), `https://console.example.com${BACKLOG_MUTATE_PATH}`);
});

test("classifyStatus maps status families", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.equal(classifyStatus(400).reason, "bad_request");
  assert.equal(classifyStatus(401).reason, "unauthorized");
  assert.equal(classifyStatus(404).reason, "not_found");
  assert.equal(classifyStatus(409).reason, "conflict");
  assert.equal(classifyStatus(422).reason, "unprocessable");
  assert.equal(classifyStatus(429).reason, "rate_limited");
  assert.equal(classifyStatus(503).reason, "upstream_error");
});

test("failure carries a stable reason + relayable message", () => {
  const f = failure("not_found");
  assert.equal(f.ok, false);
  assert.equal(f.reason, "not_found");
  assert.match(f.message, /isn't reachable/i);
  assert.equal(failure("config_missing", "custom").message, "custom");
});

test("buildMutationBody: add_labels normalizes + caps labels", () => {
  const body = buildMutationBody({
    action: "add_labels",
    repo: "o/r",
    issueNumber: 5,
    labels: ["  bug ", "", "security"],
  });
  assert.deepEqual(body, { action: "add_labels", repo: "o/r", issueNumber: 5, labels: ["bug", "security"] });
});

test("buildMutationBody: labels action with no usable label -> null", () => {
  assert.equal(buildMutationBody({ action: "add_labels", repo: "o/r", issueNumber: 5, labels: ["   "] }), null);
  assert.equal(buildMutationBody({ action: "remove_labels", repo: "o/r", issueNumber: 5, labels: [] }), null);
});

test("buildMutationBody: close carries optional stateReason + hardened comment", () => {
  const body = buildMutationBody({
    action: "close",
    repo: "o/r",
    issueNumber: 5,
    stateReason: "completed",
    comment: "done​ here, ping @everyone",
  });
  assert.equal(body.action, "close");
  assert.equal(body.stateReason, "completed");
  assert.ok(!/@everyone/.test(body.comment), "comment hardened: @everyone defanged");
  assert.ok(!/​/.test(body.comment), "comment hardened: zero-width stripped");
});

test("buildMutationBody: close with a bad stateReason -> null", () => {
  assert.equal(
    buildMutationBody({ action: "close", repo: "o/r", issueNumber: 5, stateReason: "bogus" }),
    null,
  );
});

test("buildMutationBody: dedupe requires a positive canonicalIssue distinct from issueNumber", () => {
  assert.equal(buildMutationBody({ action: "dedupe", repo: "o/r", issueNumber: 5, canonicalIssue: 5 }), null);
  assert.equal(buildMutationBody({ action: "dedupe", repo: "o/r", issueNumber: 5, canonicalIssue: 0 }), null);
  const body = buildMutationBody({ action: "dedupe", repo: "o/r", issueNumber: 5, canonicalIssue: 3 });
  assert.deepEqual(body, { action: "dedupe", repo: "o/r", issueNumber: 5, canonicalIssue: 3 });
});

test("buildMutationBody: unknown action / bad issueNumber / bad repo -> null", () => {
  assert.equal(buildMutationBody({ action: "nuke", repo: "o/r", issueNumber: 5 }), null);
  assert.equal(buildMutationBody({ action: "close", repo: "o/r", issueNumber: 0 }), null);
  assert.equal(buildMutationBody({ action: "close", repo: "", issueNumber: 5 }), null);
});

test("runBacklogMutation: unset config -> failure('config_missing'), transport never called", async () => {
  const transport = fakeTransport(() => appliedResponse());
  const res = await runBacklogMutation({
    eveSessionId: "eve-1",
    action: "add_labels",
    repo: "o/r",
    issueNumber: 5,
    labels: ["bug"],
    env: {},
    transport,
  });
  assert.equal(res.reason, "config_missing");
  assert.equal(transport.calls.length, 0);
});

test("runBacklogMutation: blank eveSessionId -> failure('bad_request')", async () => {
  const res = await runBacklogMutation({
    eveSessionId: "   ",
    action: "add_labels",
    repo: "o/r",
    issueNumber: 5,
    labels: ["bug"],
    env: ENV,
    transport: fakeTransport(() => appliedResponse()),
  });
  assert.equal(res.reason, "bad_request");
});

test("runBacklogMutation: malformed input (bad action) -> failure('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => appliedResponse());
  const res = await runBacklogMutation({
    eveSessionId: "eve-1",
    action: "nuke",
    repo: "o/r",
    issueNumber: 5,
    env: ENV,
    transport,
  });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("runBacklogMutation: success POSTs eveSessionId + the built body with the bearer, returns the console body", async () => {
  const transport = fakeTransport(() =>
    appliedResponse({ action: "close", repo: "o/r", issueNumber: 5, url: "https://github.com/o/r/issues/5" }),
  );
  const res = await runBacklogMutation({
    eveSessionId: "eve-1",
    action: "close",
    repo: "o/r",
    issueNumber: 5,
    comment: "stale",
    stateReason: "not_planned",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, "https://github.com/o/r/issues/5");
  assert.equal(transport.calls.length, 1);
  const sent = JSON.parse(transport.calls[0].init.body);
  assert.equal(sent.eveSessionId, "eve-1");
  assert.equal(sent.action, "close");
  assert.equal(sent.issueNumber, 5);
  assert.equal(sent.stateReason, "not_planned");
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
});

test("runBacklogMutation: transport throws -> failure('unreachable'), never throws", async () => {
  const res = await runBacklogMutation({
    eveSessionId: "eve-1",
    action: "add_labels",
    repo: "o/r",
    issueNumber: 5,
    labels: ["bug"],
    env: ENV,
    transport: async () => {
      throw new Error("ETIMEDOUT");
    },
  });
  assert.equal(res.reason, "unreachable");
});

test("runBacklogMutation: non-2xx surfaces the console's own error message verbatim", async () => {
  const res = await runBacklogMutation({
    eveSessionId: "eve-1",
    action: "close",
    repo: "o/r",
    issueNumber: 5,
    env: ENV,
    transport: fakeTransport(() => ({
      status: 404,
      json: async () => ({ error: "issue or repo not found on GitHub" }),
    })),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_found");
  assert.equal(res.message, "issue or repo not found on GitHub");
});

test("runBacklogMutation: 2xx but applied!=true -> failure('bad_body')", async () => {
  const res = await runBacklogMutation({
    eveSessionId: "eve-1",
    action: "close",
    repo: "o/r",
    issueNumber: 5,
    env: ENV,
    transport: fakeTransport(() => ({ status: 200, json: async () => ({ applied: false }) })),
  });
  assert.equal(res.reason, "bad_body");
});
