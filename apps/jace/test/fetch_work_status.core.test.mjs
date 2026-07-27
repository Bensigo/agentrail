// Unit tests for the work-status fetch core (no SDK, no live network). The
// single HTTP call is an injected `transport` seam, so every branch —
// success and each degraded outcome — is exercised deterministically.
// Mirrors the fakeTransport pattern from fetch_pr_diff.core.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORK_STATUS_PATH,
  resolveConsoleConfig,
  buildWorkStatusUrl,
  classifyStatus,
  degraded,
  fetchWorkStatus,
} from "../agent/lib/fetch_work_status.core.mjs";

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

function statusBody(overrides = {}) {
  return {
    ref: "issue-42",
    resolvedAs: "issue-ref",
    generatedAt: "2026-07-26T12:00:00.000Z",
    limit: 20,
    runs: [
      {
        id: "run-1",
        title: "Fix widget",
        status: "running",
        phase: "implement",
        branch: "feat/widget",
        agent: "claude",
        prUrl: null,
        costUsd: 1.23,
        startedAt: "2026-07-26T11:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-07-26T10:59:00.000Z",
        repositoryId: "repo-1",
        queueEntryId: "q-1",
        updatedAt: "2026-07-26T11:30:00.000Z",
        lastLivenessAt: "2026-07-26T11:59:00.000Z",
      },
    ],
    queueEntries: [
      {
        id: "q-1",
        externalId: "42",
        title: "Fix widget",
        state: "in_progress",
        tier: "standard",
        kind: "issue",
        createdAt: "2026-07-26T10:00:00.000Z",
        updatedAt: "2026-07-26T11:30:00.000Z",
        parkReason: null,
        blockedBy: null,
        remainingBudget: 8.77,
        estimatedBudgetUsd: 10,
      },
    ],
    truncated: { runs: false, queueEntries: false },
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
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_TOKEN: "tok" }), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL"],
  });
});

// ---------------------------------------------------------------------------
// buildWorkStatusUrl / classifyStatus
// ---------------------------------------------------------------------------

test("buildWorkStatusUrl targets the work-status route with eveSessionId + ref as query params", () => {
  const url = buildWorkStatusUrl("https://c.example.com", "eve-1", "issue-42");
  assert.equal(
    url,
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42`,
  );
});

test("buildWorkStatusUrl omits the ref param entirely when ref is blank", () => {
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", ""),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1`,
  );
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", undefined),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1`,
  );
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", "   "),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1`,
  );
});

test("buildWorkStatusUrl omits the limit param entirely when limit is not supplied", () => {
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", "issue-42"),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42`,
  );
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", "issue-42", undefined),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42`,
  );
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", "issue-42", null),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42`,
  );
  // No ref either — still no stray `limit=undefined` in the query string.
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", ""),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1`,
  );
});

test("buildWorkStatusUrl sends the limit param verbatim when supplied, without re-clamping", () => {
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", "issue-42", 200),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42&limit=200`,
  );
  // Deliberately out-of-route-range values ride through unchanged — the
  // route owns the 1..200 clamp, this function must never re-clamp.
  assert.equal(
    buildWorkStatusUrl("https://c.example.com", "eve-1", "", 9999),
    `https://c.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&limit=9999`,
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
  assert.deepEqual(classifyStatus(502), { ok: false, reason: "upstream_error" });
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
// fetchWorkStatus — success
// ---------------------------------------------------------------------------

test("fetchWorkStatus returns the full contract shape on 200 (ok path), with bearer + accept headers, exactly one attempt", async () => {
  const body = statusBody();
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", ref: "issue-42", transport });

  assert.equal(res.ok, true);
  assert.equal(res.ref, "issue-42");
  assert.equal(res.resolvedAs, "issue-ref");
  assert.equal(res.generatedAt, "2026-07-26T12:00:00.000Z");
  assert.equal(res.limit, 20);
  assert.deepEqual(res.runs, body.runs);
  assert.deepEqual(res.queueEntries, body.queueEntries);
  assert.deepEqual(res.truncated, { runs: false, queueEntries: false });

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls[0].init.headers.Accept, "application/json");
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42`,
  );
});

test("fetchWorkStatus omits the limit query param when limit is not supplied", async () => {
  const body = statusBody();
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", ref: "issue-42", transport });

  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42`,
  );
  assert.doesNotMatch(transport.calls[0].url, /limit=/);
});

test("fetchWorkStatus sends the limit query param verbatim when supplied", async () => {
  const body = statusBody();
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchWorkStatus({
    env: ENV,
    eveSessionId: "eve-1",
    ref: "issue-42",
    limit: 200,
    transport,
  });

  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1&ref=issue-42&limit=200`,
  );
});

test("fetchWorkStatus omits the ref query param when ref is blank/absent", async () => {
  const body = statusBody({ ref: null, resolvedAs: null, limit: null });
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });

  assert.equal(res.ok, true);
  assert.equal(res.ref, null);
  assert.equal(res.resolvedAs, null);
  assert.equal(res.limit, null);
  assert.equal(transport.calls.length, 1);
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${WORK_STATUS_PATH}?eveSessionId=eve-1`,
  );
});

test("fetchWorkStatus preserves resolvedAs: 'unrecognised' through the round trip", async () => {
  const body = statusBody({ ref: "gibberish", resolvedAs: "unrecognised", runs: [], queueEntries: [] });
  const transport = fakeTransport(() => ({ status: 200, json: async () => body }));

  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", ref: "gibberish", transport });

  assert.equal(res.ok, true);
  assert.equal(res.resolvedAs, "unrecognised");
  assert.equal(res.ref, "gibberish");
  assert.deepEqual(res.runs, []);
  assert.deepEqual(res.queueEntries, []);
});

test("fetchWorkStatus defensively defaults arrays/truncated/etc when the body omits or malforms them", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
  assert.equal(res.ok, true);
  assert.equal(res.ref, null);
  assert.equal(res.resolvedAs, null);
  assert.equal(res.generatedAt, "");
  assert.equal(res.limit, null);
  assert.deepEqual(res.runs, []);
  assert.deepEqual(res.queueEntries, []);
  assert.deepEqual(res.truncated, { runs: false, queueEntries: false });
});

test("fetchWorkStatus defaults truncated safely when the body's truncated field is malformed", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => statusBody({ truncated: "not-an-object" }),
  }));
  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
  assert.equal(res.ok, true);
  assert.deepEqual(res.truncated, { runs: false, queueEntries: false });
});

// ---------------------------------------------------------------------------
// fetchWorkStatus — degraded outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("degraded(bad_request) on a blank eveSessionId, before any transport call", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => statusBody() }));

  for (const args of [{ eveSessionId: "" }, { eveSessionId: "   " }, { eveSessionId: undefined }]) {
    const res = await fetchWorkStatus({ env: ENV, ...args, transport });
    assert.equal(res.degraded, true, JSON.stringify(args));
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0); // no wasted calls
});

test("degraded(config_missing) with the missing vars when console is unconfigured (singly and together)", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => statusBody() }));

  const both = await fetchWorkStatus({ env: {}, eveSessionId: "eve-1", transport });
  assert.equal(both.degraded, true);
  assert.equal(both.reason, "config_missing");
  assert.deepEqual(both.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);

  const noToken = await fetchWorkStatus({
    env: { JACE_CONSOLE_BASE_URL: "https://c.example.com" },
    eveSessionId: "eve-1",
    transport,
  });
  assert.equal(noToken.degraded, true);
  assert.equal(noToken.reason, "config_missing");
  assert.deepEqual(noToken.missing, ["JACE_CONSOLE_TOKEN"]);

  const noBaseUrl = await fetchWorkStatus({
    env: { JACE_CONSOLE_TOKEN: "tok" },
    eveSessionId: "eve-1",
    transport,
  });
  assert.equal(noBaseUrl.degraded, true);
  assert.equal(noBaseUrl.reason, "config_missing");
  assert.deepEqual(noBaseUrl.missing, ["JACE_CONSOLE_BASE_URL"]);

  assert.equal(transport.calls.length, 0);
});

test("degraded(unreachable) when the transport throws — one attempt, no retry, no leaked detail", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("degraded maps each non-2xx status (including an unmapped one) and carries the status, without the token", async () => {
  const cases = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "upstream_error"],
    [502, "upstream_error"],
    [418, "unexpected_status"],
  ];
  for (const [status, reason] of cases) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
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
  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_body");
  assert.equal(res.status, 200);
});

test("degraded(bad_body) when the console responds 200 with a non-object JSON body", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => "not-an-object" }));
  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_body");
  assert.equal(res.status, 200);
});

test("degraded(bad_body) when the console responds 200 with null JSON", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => null }));
  const res = await fetchWorkStatus({ env: ENV, eveSessionId: "eve-1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_body");
  assert.equal(res.status, 200);
});
