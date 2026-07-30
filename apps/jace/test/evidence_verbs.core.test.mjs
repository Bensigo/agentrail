// Unit tests for the debugger's shared evidence-verb core
// (agent/subagents/triage/lib/evidence_verbs.core.mjs — Task 9, debugging
// design spec: docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md;
// spec PR #1501). No SDK, no live network — every branch is exercised
// through an injected fake `transport`, mirroring
// fetch_run_evidence.core.test.mjs / fetch_investigations.core.test.mjs's
// convention. Both `fetch_changes.ts` and `search_events.ts` call the exact
// same `fetchEvidence` function with only their `verb` literal differing, so
// this file is the ONE place both tools' real logic is covered.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_PATH,
  VERBS,
  DEGRADATION_REASONS,
  resolveConsoleConfig,
  buildEvidenceUrl,
  classifyStatus,
  degraded,
  projectEnvelope,
  projectEnvelopes,
  projectDegradation,
  projectDegradations,
  renderEvidence,
  fetchEvidence,
} from "../agent/subagents/triage/lib/evidence_verbs.core.mjs";

const ENV = { JACE_CONSOLE_BASE_URL: "https://console.example.com", JACE_CONSOLE_TOKEN: "tok-123" };

function fakeTransport(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonRes(status, body) {
  return { status, json: async () => body };
}

// ---------------------------------------------------------------------------
// resolveConsoleConfig
// ---------------------------------------------------------------------------

test("resolveConsoleConfig: both vars present -> ok, trimmed, de-slashed", () => {
  const res = resolveConsoleConfig({
    JACE_CONSOLE_BASE_URL: " https://console.example.com/ ",
    JACE_CONSOLE_TOKEN: " tok ",
  });
  assert.deepEqual(res, { ok: true, baseUrl: "https://console.example.com", token: "tok" });
});

test("resolveConsoleConfig: missing vars are reported by name", () => {
  assert.deepEqual(resolveConsoleConfig({}), {
    ok: false,
    missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
  });
  assert.deepEqual(resolveConsoleConfig({ JACE_CONSOLE_BASE_URL: "https://x" }), {
    ok: false,
    missing: ["JACE_CONSOLE_TOKEN"],
  });
});

// ---------------------------------------------------------------------------
// buildEvidenceUrl
// ---------------------------------------------------------------------------

test("buildEvidenceUrl: minimal args (verb + window only)", () => {
  const url = buildEvidenceUrl("https://console.example.com", "sess_1", {
    verb: "changes",
    windowStart: "2026-07-29T13:00:00Z",
    windowEnd: "2026-07-29T14:00:00Z",
  });
  assert.equal(
    url,
    `https://console.example.com${EVIDENCE_PATH}?eveSessionId=sess_1&verb=changes` +
      `&windowStart=${encodeURIComponent("2026-07-29T13:00:00Z")}&windowEnd=${encodeURIComponent("2026-07-29T14:00:00Z")}`,
  );
});

test("buildEvidenceUrl: scope/query/limit ride only when present", () => {
  const url = buildEvidenceUrl("https://console.example.com", "sess_1", {
    verb: "search_events",
    windowStart: "2026-07-29T13:00:00Z",
    windowEnd: "2026-07-29T14:00:00Z",
    scope: "checkout-service",
    query: "pool exhausted",
    limit: 25,
  });
  assert.match(url, /verb=search_events/);
  assert.match(url, /scope=checkout-service/);
  assert.match(url, /query=pool%20exhausted/);
  assert.match(url, /limit=25/);
});

test("buildEvidenceUrl: verb param carries signals/traces exactly like any other verb (Task P1)", () => {
  for (const verb of ["signals", "traces"]) {
    const url = buildEvidenceUrl("https://console.example.com", "sess_1", {
      verb,
      windowStart: "2026-07-29T13:00:00Z",
      windowEnd: "2026-07-29T14:00:00Z",
    });
    assert.match(url, new RegExp(`verb=${verb}\\b`));
  }
});

test("buildEvidenceUrl: blank/whitespace scope and query are omitted", () => {
  const url = buildEvidenceUrl("https://console.example.com", "sess_1", {
    verb: "changes",
    windowStart: "2026-07-29T13:00:00Z",
    windowEnd: "2026-07-29T14:00:00Z",
    scope: "   ",
    query: "",
  });
  assert.doesNotMatch(url, /scope=/);
  assert.doesNotMatch(url, /query=/);
});

// ---------------------------------------------------------------------------
// classifyStatus
// ---------------------------------------------------------------------------

test("classifyStatus: 2xx ok; 400 bad_request; 401/403 unauthorized; >=500 upstream_error; 404 and others -> unexpected_status", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(204), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(502), { ok: false, reason: "upstream_error" });
  // 404 (an unresolvable session, per the route's own doc-comment) is a real
  // HTTP status this route can emit but is NOT itself one of the ten domain
  // reasons — it folds into the generic catch-all, same as any other
  // undocumented status.
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "unexpected_status" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

// ---------------------------------------------------------------------------
// degraded()
// ---------------------------------------------------------------------------

test("degraded: every one of the ten reasons has a real, cause-free note", () => {
  for (const reason of DEGRADATION_REASONS) {
    const d = degraded(reason);
    assert.equal(d.ok, false);
    assert.equal(d.degraded, true);
    assert.equal(d.reason, reason);
    assert.equal(typeof d.note, "string");
    assert.ok(d.note.length > 0, `reason "${reason}" must have a non-empty note`);
  }
});

test("degraded: extra fields ride alongside the stable shape", () => {
  const d = degraded("bad_request", { status: 400 });
  assert.equal(d.status, 400);
});

// ---------------------------------------------------------------------------
// projectEnvelope(s) / projectDegradation(s)
// ---------------------------------------------------------------------------

test("projectEnvelope: coerces a well-formed raw envelope and hardens the excerpt", () => {
  const raw = {
    ref: "inv_item_1",
    provider: "github",
    verb: "changes",
    query: { verb: "changes", windowStart: "a", windowEnd: "b" },
    capturedAt: "2026-07-29T14:02:00Z",
    excerpt: 'merged_pr #212 "fix pool sizing" merged_at=2026-07-29T14:02Z by=bensigo',
    digest: "sha256:abc123",
    truncated: false,
  };
  const p = projectEnvelope(raw);
  assert.equal(p.ref, "inv_item_1");
  assert.equal(p.provider, "github");
  assert.equal(p.verb, "changes");
  assert.deepEqual(p.query, raw.query);
  assert.equal(p.capturedAt, "2026-07-29T14:02:00Z");
  assert.equal(p.excerpt, raw.excerpt); // clean input passes through unchanged
  assert.equal(p.digest, "sha256:abc123");
  assert.equal(p.truncated, false);
});

test("projectEnvelope: strips invisible/control characters from the excerpt (hardenUntrusted)", () => {
  const raw = { ref: "r1", provider: "railway", verb: "search_events", excerpt: "error​ rate spike" };
  const p = projectEnvelope(raw);
  assert.doesNotMatch(p.excerpt, /​/);
  assert.match(p.excerpt, /error rate spike/);
});

test("projectEnvelope: tolerant of garbage input, never throws", () => {
  for (const bad of [null, undefined, "not an object", 42, []]) {
    const p = projectEnvelope(bad);
    assert.equal(p.ref, "");
    assert.equal(p.provider, "");
    assert.equal(p.excerpt, "");
    assert.equal(p.truncated, false);
  }
});

test("projectEnvelopes: non-array input yields []; array is mapped", () => {
  assert.deepEqual(projectEnvelopes(undefined), []);
  assert.deepEqual(projectEnvelopes("nope"), []);
  const list = projectEnvelopes([{ ref: "a", provider: "p", verb: "changes", excerpt: "x" }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].ref, "a");
});

test("projectDegradation: a reason outside the closed ten-set falls back to unexpected_status", () => {
  assert.deepEqual(projectDegradation({ provider: "railway", reason: "totally_made_up" }), {
    provider: "railway",
    reason: "unexpected_status",
  });
  assert.deepEqual(projectDegradation({ provider: "github", reason: "capture_failed" }), {
    provider: "github",
    reason: "capture_failed",
  });
});

test("projectDegradations: non-array -> []; tolerant of garbage entries", () => {
  assert.deepEqual(projectDegradations(null), []);
  const list = projectDegradations([{ provider: "railway", reason: "unauthorized" }, "garbage"]);
  assert.equal(list.length, 2);
  assert.equal(list[0].provider, "railway");
  assert.equal(list[1].provider, "");
});

// ---------------------------------------------------------------------------
// renderEvidence
// ---------------------------------------------------------------------------

test("renderEvidence: renders each envelope as '[ref] provider verb — excerpt'", () => {
  const rendered = renderEvidence({
    verb: "changes",
    envelopes: [
      { ref: "ev_1", provider: "github", verb: "changes", excerpt: "merged_pr #212", truncated: false },
    ],
    degradations: [],
  });
  assert.match(rendered, /\[ev_1\] github changes — merged_pr #212/);
});

test("renderEvidence: marks a truncated envelope", () => {
  const rendered = renderEvidence({
    verb: "search_events",
    envelopes: [{ ref: "ev_2", provider: "railway", verb: "search_events", excerpt: "log line", truncated: true }],
    degradations: [],
  });
  assert.match(rendered, /\[truncated\]/);
});

test("renderEvidence: renders degradations as plain provider: reason lines", () => {
  const rendered = renderEvidence({
    verb: "changes",
    envelopes: [],
    degradations: [{ provider: "railway", reason: "unauthorized" }],
  });
  assert.match(rendered, /railway: unauthorized/);
});

test("renderEvidence: no envelopes and no degradations says so honestly", () => {
  const rendered = renderEvidence({ verb: "changes", envelopes: [], degradations: [] });
  assert.match(rendered, /No changes evidence found/);
});

// ---------------------------------------------------------------------------
// renderEvidence — signals/traces (Task P1, Evidence Providers Wave 2): the
// SAME generic '[ref] provider verb — excerpt' rendering as changes/
// search_events — the core does NOT re-format series/span data, the excerpt
// IS the adapter's own pre-rendered signal/trace lines (plan-providers.md's
// pinned per-verb line conventions are the ADAPTER's job, not this core's).
// ---------------------------------------------------------------------------

test("renderEvidence: signals envelopes render exactly like other verbs — '[ref] provider signals — excerpt'", () => {
  const rendered = renderEvidence({
    verb: "signals",
    envelopes: [
      {
        ref: "ev_3",
        provider: "datadog",
        verb: "signals",
        excerpt: "signal checkout.error_rate{service=checkout} window_agg=avg value=0.22 at=2026-07-29T13:59:40Z",
        truncated: false,
      },
    ],
    degradations: [],
  });
  assert.match(
    rendered,
    /\[ev_3\] datadog signals — signal checkout\.error_rate\{service=checkout\} window_agg=avg value=0\.22 at=2026-07-29T13:59:40Z/,
  );
});

test("renderEvidence: traces envelopes render exactly like other verbs — '[ref] provider traces — excerpt'", () => {
  const rendered = renderEvidence({
    verb: "traces",
    envelopes: [
      {
        ref: "ev_4",
        provider: "langfuse",
        verb: "traces",
        excerpt: "trace tr_88 checkout.submit duration_ms=4210 status=error at=2026-07-29T13:59:41Z",
        truncated: false,
      },
    ],
    degradations: [],
  });
  assert.match(
    rendered,
    /\[ev_4\] langfuse traces — trace tr_88 checkout\.submit duration_ms=4210 status=error at=2026-07-29T13:59:41Z/,
  );
});

test("renderEvidence: signals excerpt with multiple pre-rendered signal lines passes through un-reformatted (only hardenUntrusted applies)", () => {
  const multiLine = "signal a.rate window_agg=avg value=1 at=2026-07-29T13:00:00Z\nsignal b.rate window_agg=max value=2 at=2026-07-29T13:01:00Z";
  const rendered = renderEvidence({
    verb: "signals",
    envelopes: [{ ref: "ev_5", provider: "prometheus", verb: "signals", excerpt: multiLine, truncated: false }],
    degradations: [],
  });
  assert.match(rendered, /signal a\.rate window_agg=avg value=1 at=2026-07-29T13:00:00Z/);
  assert.match(rendered, /signal b\.rate window_agg=max value=2 at=2026-07-29T13:01:00Z/);
});

test("renderEvidence: no signals evidence and no traces evidence say so honestly, verb-echoed", () => {
  assert.match(renderEvidence({ verb: "signals", envelopes: [], degradations: [] }), /No signals evidence found/);
  assert.match(renderEvidence({ verb: "traces", envelopes: [], degradations: [] }), /No traces evidence found/);
});

// ---------------------------------------------------------------------------
// fetchEvidence — local validation (no transport call)
// ---------------------------------------------------------------------------

test("fetchEvidence: blank eveSessionId -> bad_request, no transport call", async () => {
  const transport = fakeTransport(() => jsonRes(200, {}));
  const res = await fetchEvidence({
    eveSessionId: "  ",
    verb: "changes",
    windowStart: "a",
    windowEnd: "b",
    env: ENV,
    transport,
  });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchEvidence: unknown verb -> bad_request, no transport call", async () => {
  const transport = fakeTransport(() => jsonRes(200, {}));
  const res = await fetchEvidence({
    eveSessionId: "s1",
    verb: "probe", // in the console's own EvidenceVerb type, but no adapter/tool yet (spec: "Out of scope")
    windowStart: "a",
    windowEnd: "b",
    env: ENV,
    transport,
  });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchEvidence: missing windowStart or windowEnd -> bad_request, no transport call", async () => {
  const transport = fakeTransport(() => jsonRes(200, {}));
  const res1 = await fetchEvidence({ eveSessionId: "s1", verb: "changes", windowEnd: "b", env: ENV, transport });
  assert.equal(res1.reason, "bad_request");
  const res2 = await fetchEvidence({ eveSessionId: "s1", verb: "changes", windowStart: "a", env: ENV, transport });
  assert.equal(res2.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchEvidence: unset console config -> config_missing, no transport call", async () => {
  const transport = fakeTransport(() => jsonRes(200, {}));
  const res = await fetchEvidence({
    eveSessionId: "s1",
    verb: "changes",
    windowStart: "a",
    windowEnd: "b",
    env: {},
    transport,
  });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

test("VERBS is exactly ['changes', 'search_events', 'signals', 'traces'] (v1, widened by Task P1)", () => {
  assert.deepEqual([...VERBS].sort(), ["changes", "search_events", "signals", "traces"]);
});

// ---------------------------------------------------------------------------
// fetchEvidence — transport-level outcomes
// ---------------------------------------------------------------------------

function call(overrides = {}) {
  return {
    eveSessionId: "sess_1",
    verb: "changes",
    windowStart: "2026-07-29T13:00:00Z",
    windowEnd: "2026-07-29T14:00:00Z",
    env: ENV,
    ...overrides,
  };
}

test("fetchEvidence: transport throws -> unreachable, never throws itself", async () => {
  const transport = async () => {
    throw new Error("ECONNREFUSED");
  };
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unreachable");
});

test("fetchEvidence: sends Authorization: Bearer <token> and Accept: application/json, GET", async () => {
  const transport = fakeTransport(() => jsonRes(200, { envelopes: [], degradations: [] }));
  await fetchEvidence(call({ transport }));
  assert.equal(transport.calls.length, 1);
  const { url, init } = transport.calls[0];
  assert.match(url, /^https:\/\/console\.example\.com\/api\/v1\/runner\/evidence\?/);
  assert.equal(init.headers.Authorization, "Bearer tok-123");
  assert.equal(init.headers.Accept, "application/json");
});

for (const [status, reason] of [
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "unauthorized"],
  [404, "unexpected_status"],
  [500, "upstream_error"],
  [502, "upstream_error"],
]) {
  test(`fetchEvidence: HTTP ${status} -> degraded("${reason}")`, async () => {
    const transport = fakeTransport(() => jsonRes(status, { error: "nope" }));
    const res = await fetchEvidence(call({ transport }));
    assert.equal(res.ok, false);
    assert.equal(res.reason, reason);
    assert.equal(res.status, status);
  });
}

test("fetchEvidence: 200 with unparseable JSON body -> bad_body", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  }));
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.reason, "bad_body");
});

test("fetchEvidence: 200 body {degraded:true, reason:'no_investigation'} is relayed at the top level", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "no_investigation" }));
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.ok, false);
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "no_investigation");
});

test("fetchEvidence: 200 body {degraded:true, reason:'no_provider'} is relayed at the top level", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "no_provider" }));
  const res = await fetchEvidence(call({ verb: "search_events", transport }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_provider");
});

// ---------------------------------------------------------------------------
// degraded notes are resolved PER-VERB for no_provider (Task P1, Evidence
// Providers Wave 2: .superpowers/sdd/plan-providers.md's pinned decision) —
// "no metrics provider" / "no tracing provider" read differently than the
// generic "no provider answers this verb" changes/search_events keep. Every
// other reason stays verb-independent (asserted by the generic "every one of
// the ten reasons has a real note" test above, which never passes a verb).
// ---------------------------------------------------------------------------

test("fetchEvidence: no_provider note for signals names metrics specifically, distinct from the generic note", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "no_provider" }));
  const res = await fetchEvidence(call({ verb: "signals", transport }));
  assert.equal(res.reason, "no_provider");
  assert.match(res.note, /metrics/i);
  assert.notEqual(res.note, degraded("no_provider").note, "signals' no_provider note must differ from the generic one");
});

test("fetchEvidence: no_provider note for traces names tracing specifically, distinct from the generic note", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "no_provider" }));
  const res = await fetchEvidence(call({ verb: "traces", transport }));
  assert.equal(res.reason, "no_provider");
  assert.match(res.note, /tracing/i);
  assert.notEqual(res.note, degraded("no_provider").note, "traces' no_provider note must differ from the generic one");
});

test("fetchEvidence: no_provider note for changes/search_events is unchanged by the Task P1 per-verb refinement", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "no_provider" }));
  const changesRes = await fetchEvidence(call({ verb: "changes", transport }));
  const searchRes = await fetchEvidence(call({ verb: "search_events", transport }));
  assert.equal(changesRes.note, degraded("no_provider").note);
  assert.equal(searchRes.note, degraded("no_provider").note);
});

test("fetchEvidence: a non-no_provider reason (e.g. no_investigation) is untouched by the per-verb refinement even for signals/traces", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "no_investigation" }));
  const res = await fetchEvidence(call({ verb: "signals", transport }));
  assert.equal(res.reason, "no_investigation");
  assert.equal(res.note, degraded("no_investigation").note);
});

test("fetchEvidence: 200 body {degraded:true, reason:<unrecognized>} falls back to unexpected_status defensively", async () => {
  const transport = fakeTransport(() => jsonRes(200, { degraded: true, reason: "some_future_reason" }));
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unexpected_status");
});

test("fetchEvidence: success — envelopes + degradations projected, rendered, verb echoed", async () => {
  const transport = fakeTransport(() =>
    jsonRes(200, {
      envelopes: [
        {
          ref: "ev_1",
          provider: "github",
          verb: "changes",
          query: { verb: "changes", windowStart: "a", windowEnd: "b" },
          capturedAt: "2026-07-29T14:02:00Z",
          excerpt: 'merged_pr #212 "fix pool sizing"',
          digest: "sha256:abc",
          truncated: false,
        },
      ],
      degradations: [{ provider: "railway", reason: "unauthorized" }],
    }),
  );
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.ok, true);
  assert.equal(res.verb, "changes");
  assert.equal(res.envelopes.length, 1);
  assert.equal(res.envelopes[0].ref, "ev_1");
  assert.equal(res.degradations.length, 1);
  assert.equal(res.degradations[0].provider, "railway");
  assert.match(res.rendered, /\[ev_1\] github changes/);
  assert.match(res.rendered, /railway: unauthorized/);
});

test("fetchEvidence: success with EMPTY envelopes and degradations — both arrays always present", async () => {
  const transport = fakeTransport(() => jsonRes(200, { envelopes: [], degradations: [] }));
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.envelopes, []);
  assert.deepEqual(res.degradations, []);
});

test("fetchEvidence: search_events verb and query are forwarded", async () => {
  const transport = fakeTransport(() => jsonRes(200, { envelopes: [], degradations: [] }));
  await fetchEvidence(
    call({ verb: "search_events", query: "pool exhausted", scope: "checkout-service", limit: 10, transport }),
  );
  const { url } = transport.calls[0];
  assert.match(url, /verb=search_events/);
  assert.match(url, /query=pool%20exhausted/);
  assert.match(url, /scope=checkout-service/);
  assert.match(url, /limit=10/);
});

// ---------------------------------------------------------------------------
// fetchEvidence — signals/traces (Task P1, Evidence Providers Wave 2): the
// request URL carries the right verb param, and a successful fan-out
// projects/renders exactly like any other verb.
// ---------------------------------------------------------------------------

test("fetchEvidence: signals request URL carries verb=signals, scope/query/limit forwarded", async () => {
  const transport = fakeTransport(() => jsonRes(200, { envelopes: [], degradations: [] }));
  await fetchEvidence(
    call({ verb: "signals", query: "checkout.error_rate", scope: "checkout-service", limit: 10, transport }),
  );
  const { url } = transport.calls[0];
  assert.match(url, /verb=signals/);
  assert.match(url, /query=checkout\.error_rate/);
  assert.match(url, /scope=checkout-service/);
  assert.match(url, /limit=10/);
});

test("fetchEvidence: traces request URL carries verb=traces, scope/query/limit forwarded", async () => {
  const transport = fakeTransport(() => jsonRes(200, { envelopes: [], degradations: [] }));
  await fetchEvidence(
    call({ verb: "traces", query: "checkout.submit", scope: "checkout-service", limit: 10, transport }),
  );
  const { url } = transport.calls[0];
  assert.match(url, /verb=traces/);
  assert.match(url, /query=checkout\.submit/);
  assert.match(url, /scope=checkout-service/);
  assert.match(url, /limit=10/);
});

test("fetchEvidence: signals success — envelopes + degradations projected, rendered, verb echoed", async () => {
  const transport = fakeTransport(() =>
    jsonRes(200, {
      envelopes: [
        {
          ref: "ev_6",
          provider: "datadog",
          verb: "signals",
          query: { verb: "signals", windowStart: "a", windowEnd: "b" },
          capturedAt: "2026-07-29T14:02:00Z",
          excerpt: "signal checkout.error_rate window_agg=avg value=0.22 at=2026-07-29T13:59:40Z",
          digest: "sha256:def",
          truncated: false,
        },
      ],
      degradations: [{ provider: "prometheus", reason: "no_provider" }],
    }),
  );
  const res = await fetchEvidence(call({ verb: "signals", transport }));
  assert.equal(res.ok, true);
  assert.equal(res.verb, "signals");
  assert.equal(res.envelopes.length, 1);
  assert.equal(res.envelopes[0].ref, "ev_6");
  assert.equal(res.degradations.length, 1);
  assert.match(res.rendered, /\[ev_6\] datadog signals — signal checkout\.error_rate/);
  assert.match(res.rendered, /prometheus: no_provider/);
});

test("fetchEvidence: traces success — envelopes + degradations projected, rendered, verb echoed", async () => {
  const transport = fakeTransport(() =>
    jsonRes(200, {
      envelopes: [
        {
          ref: "ev_7",
          provider: "langfuse",
          verb: "traces",
          query: { verb: "traces", windowStart: "a", windowEnd: "b" },
          capturedAt: "2026-07-29T14:02:00Z",
          excerpt: "trace tr_88 checkout.submit duration_ms=4210 status=error at=2026-07-29T13:59:41Z",
          digest: "sha256:ghi",
          truncated: false,
        },
      ],
      degradations: [],
    }),
  );
  const res = await fetchEvidence(call({ verb: "traces", transport }));
  assert.equal(res.ok, true);
  assert.equal(res.verb, "traces");
  assert.equal(res.envelopes.length, 1);
  assert.equal(res.envelopes[0].ref, "ev_7");
  assert.deepEqual(res.degradations, []);
  assert.match(res.rendered, /\[ev_7\] langfuse traces — trace tr_88 checkout\.submit duration_ms=4210 status=error/);
});

test("fetchEvidence: never throws even on a completely malformed 200 body", async () => {
  const transport = fakeTransport(() => jsonRes(200, "just a string, not an object"));
  const res = await fetchEvidence(call({ transport }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_body");
});
