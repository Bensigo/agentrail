// Unit tests for the triage subagent's fetch core (no SDK, no live network).
// The single HTTP call is an injected `transport` seam, so every branch —
// success and each degraded outcome (AC5) — is exercised deterministically.
//
// AC5: fetching evidence NEVER throws and NEVER retries. On an unconfigured,
// unreachable, or failing console the core returns a degraded result carrying a
// stable reason + a cause-free note (never the run's failure, never transport
// error text, never the bearer token).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLE_PATH,
  resolveConsoleConfig,
  buildBundleUrl,
  classifyStatus,
  degraded,
  fetchRunEvidence,
} from "../agent/subagents/triage/lib/fetch_run_evidence.core.mjs";

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
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_TOKEN: "t" }), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL"],
  });
  // Whitespace-only is treated as unset.
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "   ", JACE_CONSOLE_TOKEN: "  " }), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});

// ---------------------------------------------------------------------------
// buildBundleUrl / classifyStatus
// ---------------------------------------------------------------------------

test("buildBundleUrl targets the failure-bundle route and URL-encodes the run_id", () => {
  const url = buildBundleUrl("https://c.example.com", "run/abc 123");
  assert.equal(url, `https://c.example.com${BUNDLE_PATH}?run_id=run%2Fabc%20123`);
});

test("buildBundleUrl throws on a blank run_id", () => {
  assert.throws(() => buildBundleUrl("https://c", ""));
  assert.throws(() => buildBundleUrl("https://c", "   "));
});

test("classifyStatus maps HTTP status to outcome (2xx ok, rest degraded reasons)", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(204), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(503), { ok: false, reason: "upstream_error" });
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
  // Unknown reasons still yield a safe note (never undefined).
  assert.equal(typeof degraded("who_knows").note, "string");
});

// ---------------------------------------------------------------------------
// fetchRunEvidence — success
// ---------------------------------------------------------------------------

test("fetchRunEvidence returns the bundle + evidence_summary on 200 (ok path)", async () => {
  const bundle = {
    run: { run_id: "run_1", status: "failed" },
    failure_events: [{ text: "boom" }],
    review_gates: [],
    timeline: [{ event: "phase_start" }],
  };
  const transport = fakeTransport(() => ({ status: 200, json: async () => bundle }));
  const res = await fetchRunEvidence({ env: ENV, runId: "run_1", transport });
  assert.equal(res.ok, true);
  assert.equal(res.run_id, "run_1");
  assert.deepEqual(res.bundle, bundle);
  assert.deepEqual(res.evidence_summary.present.sort(), ["failure_events", "run", "timeline"]);
  assert.deepEqual(res.evidence_summary.missing, ["review_gates"]);
  // Exactly one attempt, with the bearer + accept headers.
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].init.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls[0].init.headers.Accept, "application/json");
  assert.equal(
    transport.calls[0].url,
    `https://console.example.com${BUNDLE_PATH}?run_id=run_1`,
  );
});

// ---------------------------------------------------------------------------
// fetchRunEvidence — degraded outcomes (AC5), never throws, never retries
// ---------------------------------------------------------------------------

test("degraded(bad_request) on a blank run_id, before any transport call", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const res = await fetchRunEvidence({ env: ENV, runId: "   ", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0); // no wasted call
});

test("degraded(config_missing) with the missing vars when console is unconfigured", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
  const res = await fetchRunEvidence({ env: {}, runId: "run_1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

test("degraded(unreachable) when the transport throws — one attempt, no retry (AC5)", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchRunEvidence({ env: ENV, runId: "run_1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1); // exactly one attempt, not retried
  // The transport's error text must NOT leak into the result.
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("degraded maps each non-2xx status and carries the status, without the token", async () => {
  const cases = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
    [500, "upstream_error"],
    [418, "unexpected_status"],
  ];
  for (const [status, reason] of cases) {
    const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
    const res = await fetchRunEvidence({ env: ENV, runId: "run_1", transport });
    assert.equal(res.degraded, true, `status ${status} must degrade`);
    assert.equal(res.reason, reason, `status ${status} → ${reason}`);
    assert.equal(res.status, status);
    assert.equal(transport.calls.length, 1);
    // The bearer token must never ride out in a degraded result.
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
  const res = await fetchRunEvidence({ env: ENV, runId: "run_1", transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_body");
  assert.equal(res.status, 200);
});
