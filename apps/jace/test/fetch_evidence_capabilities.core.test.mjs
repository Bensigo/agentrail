// Unit tests for the evidence-capabilities fetch core (no SDK, no live
// network). The single HTTP call is an injected `transport` seam, so every
// branch — the happy render (both a populated verb and an empty-gap verb),
// every degraded reason, the blank-session fallback, and end-to-end
// hardening — is exercised deterministically. Mirrors
// fetch_investigations.core.test.mjs's fakeTransport pattern; see that file
// + agent/lib/fetch_investigations.core.mjs for the template this module is
// a structural sibling of (T8 idiom), narrowed to ONE mode and NO params.
//
// The fetch NEVER throws and NEVER retries. On an unconfigured, unreachable,
// or failing console the core returns a degraded result carrying a stable
// reason + a cause-free note (never transport error text, never the bearer
// token).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_PATH,
  VERB_PHRASES,
  resolveConsoleConfig,
  buildCapabilitiesUrl,
  classifyStatus,
  degraded,
  projectCapabilities,
  renderCapabilities,
  fetchEvidenceCapabilities,
} from "../agent/lib/fetch_evidence_capabilities.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};
const EVE_SESSION_ID = "eve-session-abc";

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function okResponse(body) {
  return { status: 200, json: async () => body };
}

function fullEvidence(overrides = {}) {
  return {
    changes: ["github", "railway", "factory"],
    search_events: ["railway", "factory"],
    signals: [],
    traces: [],
    probe: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildCapabilitiesUrl / classifyStatus / degraded
// ---------------------------------------------------------------------------

test("resolveConsoleConfig: ok when both env vars set, trims + de-slashes baseUrl", () => {
  const cfg = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: " https://console.example.com/ ",
    JACE_CONSOLE_TOKEN: " tok ",
  });
  assert.deepEqual(cfg, { ok: true, baseUrl: "https://console.example.com", token: "tok" });
});

test("resolveConsoleConfig: reports every missing var by name", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
});

test("buildCapabilitiesUrl: always carries mode=capabilities plus the session id, never any other param", () => {
  const url = buildCapabilitiesUrl("https://console.example.com", EVE_SESSION_ID);
  assert.equal(url, "https://console.example.com/api/v1/runner/evidence?eveSessionId=eve-session-abc&mode=capabilities");
});

test("buildCapabilitiesUrl: omits eveSessionId param when blank, still carries mode", () => {
  const url = buildCapabilitiesUrl("https://console.example.com", "");
  assert.equal(url, "https://console.example.com/api/v1/runner/evidence?mode=capabilities");
});

test("EVIDENCE_PATH matches the console's runner evidence route", () => {
  assert.equal(EVIDENCE_PATH, "/api/v1/runner/evidence");
});

test("classifyStatus: maps every status the same way fetch_investigations.core.mjs does", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded: carries ok:false, degraded:true, a stable reason, and a cause-free note", () => {
  const d = degraded("unreachable");
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "unreachable");
  assert.match(d.note, /could not be reached/);
});

test("VERB_PHRASES: fixed five-verb order matching the console's EVIDENCE_VERBS", () => {
  assert.deepEqual(
    VERB_PHRASES.map((v) => v.verb),
    ["changes", "search_events", "signals", "traces", "probe"],
  );
});

// ---------------------------------------------------------------------------
// projectCapabilities
// ---------------------------------------------------------------------------

test("projectCapabilities: every verb key always present, even on a malformed/empty body", () => {
  assert.deepEqual(projectCapabilities(undefined), {
    changes: [], search_events: [], signals: [], traces: [], probe: [],
  });
  assert.deepEqual(projectCapabilities({}), {
    changes: [], search_events: [], signals: [], traces: [], probe: [],
  });
  assert.deepEqual(projectCapabilities({ evidence: "not an object" }), {
    changes: [], search_events: [], signals: [], traces: [], probe: [],
  });
});

test("projectCapabilities: projects a real evidence map, drops non-strings, caps the count", () => {
  const p = projectCapabilities({
    evidence: fullEvidence({ changes: ["github", "railway", 42, null, "factory"] }),
  });
  assert.deepEqual(p.changes, ["github", "railway", "factory"]);
  assert.deepEqual(p.search_events, ["railway", "factory"]);
  assert.deepEqual(p.signals, []);
});

test("projectCapabilities: hardens each provider string defensively (strips invisibles, defangs dangerous schemes)", () => {
  const p = projectCapabilities({
    evidence: fullEvidence({ changes: ["github​", "javascript:alert(1)"] }),
  });
  assert.doesNotMatch(p.changes[0], /​/, "zero-width space stripped");
  assert.match(p.changes[1], /javascript\[:\]alert\(1\)/, "dangerous scheme defanged");
});

// ---------------------------------------------------------------------------
// renderCapabilities — happy render, BOTH branches (populated + gap)
// ---------------------------------------------------------------------------

test("renderCapabilities: a populated verb renders capability-first with providers parenthesized", () => {
  const rendered = renderCapabilities(fullEvidence());
  assert.match(rendered, /I can inspect deployments and merges \(github, railway, factory\)\./);
  assert.match(rendered, /I can search logs and events \(railway, factory\)\./);
});

test("renderCapabilities: an empty verb renders an honest gap, never a bare empty list", () => {
  const rendered = renderCapabilities(fullEvidence());
  assert.match(rendered, /I cannot inspect metrics yet — no provider is connected\./);
  assert.match(rendered, /I cannot inspect traces yet — no provider is connected\./);
  assert.match(rendered, /I cannot probe the live app yet — no provider is connected\./);
});

test("renderCapabilities: renders all five verbs, one line each, in fixed order", () => {
  const rendered = renderCapabilities(fullEvidence());
  const lines = rendered.split("\n").slice(1); // drop the header line
  assert.equal(lines.length, 5);
});

test("renderCapabilities: tolerant of a missing/malformed evidence object, never throws", () => {
  assert.doesNotThrow(() => renderCapabilities(undefined));
  assert.doesNotThrow(() => renderCapabilities({}));
  const rendered = renderCapabilities({});
  assert.match(rendered, /I cannot inspect deployments and merges yet — no provider is connected\./);
});

// ---------------------------------------------------------------------------
// fetchEvidenceCapabilities — session fallback
// ---------------------------------------------------------------------------

test("fetchEvidenceCapabilities: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ evidence: fullEvidence() }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: "", env: ENV, transport });
  assert.equal(res.ok, false);
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchEvidenceCapabilities: whitespace-only eveSessionId -> degraded('bad_request')", async () => {
  const transport = fakeTransport(() => okResponse({ evidence: fullEvidence() }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: "   ", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// fetchEvidenceCapabilities — degraded reasons
// ---------------------------------------------------------------------------

test("fetchEvidenceCapabilities: unset console config -> degraded('config_missing') with the missing var names", async () => {
  const transport = fakeTransport(() => okResponse({ evidence: fullEvidence() }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: {}, transport });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

test("fetchEvidenceCapabilities: transport throws -> degraded('unreachable'), never propagates", async () => {
  const transport = async () => { throw new Error("ECONNREFUSED"); };
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.reason, "unreachable");
});

test("fetchEvidenceCapabilities: 401 -> degraded('unauthorized')", async () => {
  const transport = fakeTransport(() => ({ status: 401, json: async () => ({ error: "bad token" }) }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.reason, "unauthorized");
});

test("fetchEvidenceCapabilities: 404 (session not found) -> degraded('not_found')", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Session not found" }) }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.reason, "not_found");
});

test("fetchEvidenceCapabilities: 502 -> degraded('upstream_error')", async () => {
  const transport = fakeTransport(() => ({ status: 502, json: async () => ({ error: "Upstream storage error" }) }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
});

test("fetchEvidenceCapabilities: 200 with non-JSON body -> degraded('bad_body')", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => { throw new SyntaxError("Unexpected token"); },
  }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("fetchEvidenceCapabilities: unexpected status (e.g. 418) -> degraded('unexpected_status')", async () => {
  const transport = fakeTransport(() => ({ status: 418, json: async () => ({}) }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.reason, "unexpected_status");
});

// ---------------------------------------------------------------------------
// fetchEvidenceCapabilities — happy path end-to-end
// ---------------------------------------------------------------------------

test("fetchEvidenceCapabilities: success carries ok:true, the projected evidence map, and the rendered text", async () => {
  const transport = fakeTransport((url, init) => {
    assert.match(url, /mode=capabilities/);
    assert.match(url, /eveSessionId=eve-session-abc/);
    assert.equal(init.headers.Authorization, "Bearer tok-secret-123");
    return okResponse({ evidence: fullEvidence() });
  });
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.ok, true);
  assert.deepEqual(res.evidence, fullEvidence());
  assert.match(res.rendered, /I can inspect deployments and merges \(github, railway, factory\)\./);
  assert.match(res.rendered, /I cannot inspect metrics yet — no provider is connected\./);
});

test("fetchEvidenceCapabilities: an all-empty capability map renders five honest gaps, no crash", async () => {
  const transport = fakeTransport(() => okResponse({
    evidence: { changes: [], search_events: [], signals: [], traces: [], probe: [] },
  }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.equal(res.ok, true);
  const gapLines = res.rendered.split("\n").filter((l) => l.includes("no provider is connected"));
  assert.equal(gapLines.length, 5);
});

// ---------------------------------------------------------------------------
// End-to-end hardening of hostile content
// ---------------------------------------------------------------------------

test("fetchEvidenceCapabilities: a hostile provider string (zero-width chars, javascript: URL) renders inert end-to-end", async () => {
  const transport = fakeTransport(() => okResponse({
    evidence: fullEvidence({ changes: ["github​", "javascript:alert(1)"] }),
  }));
  const res = await fetchEvidenceCapabilities({ eveSessionId: EVE_SESSION_ID, env: ENV, transport });
  assert.doesNotMatch(res.rendered, /​/);
  assert.doesNotMatch(res.rendered, /javascript:alert/);
  assert.match(res.rendered, /javascript\[:\]alert\(1\)/);
});
