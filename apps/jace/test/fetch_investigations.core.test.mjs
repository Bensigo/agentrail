// Unit tests for the investigations fetch core (no SDK, no live network). The
// single HTTP call is an injected `transport` seam, so every branch —
// success, the honest "no investigation yet", and each degraded outcome — is
// exercised deterministically. Mirrors fetch_briefs.core.test.mjs's
// fakeTransport pattern; see that file + agent/lib/fetch_briefs.core.mjs for
// the template this module is a line-for-line structural sibling of.
//
// LOAD-BEARING DIFFERENCE FROM BRIEFS (per the landed T3 route, which governs
// over the plan text): the wire response is FLATTER than briefs' `{ brief }`
// wrapper — `get`/`anchor` spread `investigation`/`items`/`eligibility` as
// sibling top-level keys, not nested under a `brief`/`anchor` key. `list`/
// `search` return bare index rows with NO items and NO eligibility (unlike
// briefs, where list/search rows technically project an empty items array) —
// a caller wanting item detail or eligibility follows up with mode="get".
//
// The fetch NEVER throws and NEVER retries. On an unconfigured, unreachable,
// or failing console the core returns a degraded result carrying a stable
// reason + a cause-free note (never an investigation's content, never
// transport error text, never the bearer token).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVESTIGATIONS_PATH,
  MODES,
  UNTRUSTED_NOTICE,
  resolveConsoleConfig,
  buildInvestigationsUrl,
  classifyStatus,
  degraded,
  projectInvestigationItem,
  projectInvestigationItems,
  projectInvestigation,
  projectInvestigationWithItems,
  projectInvestigations,
  projectEligibility,
  renderList,
  renderInvestigationDetail,
  renderEligibility,
  renderGet,
  renderAnchor,
  renderSearch,
  fetchInvestigations,
} from "../agent/lib/fetch_investigations.core.mjs";

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

function item(overrides = {}) {
  return {
    id: "item-1",
    kind: "hypothesis",
    body: "pool exhaustion under load",
    mechanism: "connection pool starves at high concurrency",
    state: "open",
    evidenceRefs: ["ev-1"],
    data: {},
    authority: "jace",
    createdAt: "2026-07-29T14:57:00Z",
    updatedAt: "2026-07-29T15:10:00Z",
    ...overrides,
  };
}

function investigation(overrides = {}) {
  return {
    id: "inv-uuid-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "checkout-500s",
    title: "Checkout 500s",
    status: "open",
    severity: "high",
    openedBy: "chat",
    symptomStatement: "Checkout returns 500 for about 5% of requests since ~14:00 UTC.",
    symptomSignature: "checkout 500 error rate spike",
    affectedSurface: "checkout service",
    firstSeenAt: "2026-07-29T14:00:00Z",
    verdict: null,
    confidence: null,
    depthBudget: 8,
    jaceSessionIds: ["sess-1"],
    createdAt: "2026-07-29T14:05:00Z",
    updatedAt: "2026-07-29T15:10:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MODES / resolveConsoleConfig
// ---------------------------------------------------------------------------

test("MODES is exactly anchor/list/get/search, anchor first (call order matters)", () => {
  assert.deepEqual(MODES, ["anchor", "list", "get", "search"]);
});

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
});

// ---------------------------------------------------------------------------
// buildInvestigationsUrl
// ---------------------------------------------------------------------------

test("buildInvestigationsUrl always carries eveSessionId + mode", () => {
  const url = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, { mode: "list" });
  assert.equal(
    url,
    `https://c.example.com${INVESTIGATIONS_PATH}?eveSessionId=${encodeURIComponent(EVE_SESSION_ID)}&mode=list`,
  );
});

test("buildInvestigationsUrl carries slug only for mode=get", () => {
  const getUrl = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "get",
    slug: "checkout-500s",
  });
  assert.match(getUrl, /[?&]slug=checkout-500s/);

  const listUrl = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "list",
    slug: "checkout-500s",
  });
  assert.doesNotMatch(listUrl, /[?&]slug=/);
});

test("buildInvestigationsUrl carries query only for mode=search", () => {
  const searchUrl = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "search",
    query: "checkout 500",
  });
  assert.match(searchUrl, /[?&]query=checkout%20500/);

  const listUrl = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "list",
    query: "checkout 500",
  });
  assert.doesNotMatch(listUrl, /[?&]query=/);
});

test("buildInvestigationsUrl mode=anchor carries only eveSessionId + mode — no slug/query even if passed", () => {
  const url = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "anchor",
    slug: "checkout-500s",
    query: "checkout 500",
  });
  assert.equal(
    url,
    `https://c.example.com${INVESTIGATIONS_PATH}?eveSessionId=${encodeURIComponent(EVE_SESSION_ID)}&mode=anchor`,
  );
});

test("buildInvestigationsUrl NEVER carries a workspace param — the workspace is resolved server-side from eveSessionId", () => {
  const url = buildInvestigationsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "search",
    query: "workspaceId=evil-tenant",
  });
  assert.doesNotMatch(url, /[?&]workspaceId=/);
});

// ---------------------------------------------------------------------------
// classifyStatus / degraded
// ---------------------------------------------------------------------------

test("classifyStatus maps HTTP status to outcome (2xx ok, rest degraded reasons, 502 folds into upstream_error)", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(502), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded carries a stable reason + cause-free note for every taxonomy entry", () => {
  for (const reason of [
    "config_missing",
    "bad_request",
    "missing_slug",
    "missing_query",
    "unreachable",
    "unauthorized",
    "not_found",
    "upstream_error",
    "unexpected_status",
    "bad_body",
  ]) {
    const d = degraded(reason);
    assert.equal(d.ok, false);
    assert.equal(d.degraded, true);
    assert.equal(d.reason, reason);
    assert.ok(d.note.length > 0, `reason ${reason} must carry a non-empty note`);
  }
});

test("degraded('missing_slug' | 'missing_query') gives a corrective, not just a generic failure", () => {
  assert.match(degraded("missing_slug").note, /mode="get".*requires a slug/i);
  assert.match(degraded("missing_query").note, /mode="search".*requires a query/i);
});

test("degraded('not_found') frames a missing investigation as expected, not a fetch failure", () => {
  assert.match(degraded("not_found").note, /brand-new incident/i);
});

// ---------------------------------------------------------------------------
// projectInvestigationItem / projectInvestigationItems
// ---------------------------------------------------------------------------

test("projectInvestigationItem keeps the contract fields, maps wire evidenceRefs -> model-facing evidence_refs", () => {
  const p = projectInvestigationItem(item());
  assert.deepEqual(p, {
    id: "item-1",
    kind: "hypothesis",
    body: "pool exhaustion under load",
    mechanism: "connection pool starves at high concurrency",
    state: "open",
    evidence_refs: ["ev-1"],
    data: {},
    authority: "jace",
    createdAt: "2026-07-29T14:57:00Z",
    updatedAt: "2026-07-29T15:10:00Z",
  });
});

test("projectInvestigationItem tolerates a missing/malformed raw item (never throws)", () => {
  assert.deepEqual(projectInvestigationItem(null), {
    id: "",
    kind: "",
    body: "",
    mechanism: "",
    state: null,
    evidence_refs: [],
    data: {},
    authority: "",
    createdAt: "",
    updatedAt: "",
  });
});

test("projectInvestigationItem runs body/mechanism through hardenUntrusted: strips invisibles, defangs dangerous schemes", () => {
  const p = projectInvestigationItem(
    item({
      body: "see javascript:alert(1) ​here",
      mechanism: "click javascript:alert(2) ​now",
    }),
  );
  assert.doesNotMatch(p.body, /​/, "zero-width space stripped");
  assert.match(p.body, /javascript\[:\]alert\(1\)/, "dangerous scheme defanged in body");
  assert.match(p.mechanism, /javascript\[:\]alert\(2\)/, "dangerous scheme defanged in mechanism");
});

test("projectInvestigationItem hardens each evidence_refs entry defensively, tolerant of non-string entries", () => {
  const p = projectInvestigationItem(item({ evidenceRefs: ["javascript:alert(1)​", 42, null] }));
  assert.equal(p.evidence_refs.length, 1, "non-string entries are dropped, never throw");
  assert.match(p.evidence_refs[0], /javascript\[:\]alert\(1\)/);
});

test("projectInvestigationItem passes data through defensively as a plain object, never hardened (structured, not prose)", () => {
  const p = projectInvestigationItem(item({ data: { provider: "github", verb: "changes" } }));
  assert.deepEqual(p.data, { provider: "github", verb: "changes" });
  assert.deepEqual(projectInvestigationItem(item({ data: null })).data, {});
  assert.deepEqual(projectInvestigationItem(item({ data: "not an object" })).data, {});
});

test("projectInvestigationItems projects every entry and tolerates a missing/non-array field", () => {
  assert.deepEqual(projectInvestigationItems(undefined), []);
  assert.deepEqual(projectInvestigationItems(null), []);
  const list = projectInvestigationItems([item({ id: "a" }), item({ id: "b" })]);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "a");
  assert.equal(list[1].id, "b");
});

// ---------------------------------------------------------------------------
// projectInvestigation / projectInvestigationWithItems / projectInvestigations
// ---------------------------------------------------------------------------

test("projectInvestigation keeps the contract fields, drops the raw db id/workspaceId/repositoryId", () => {
  const p = projectInvestigation(investigation());
  assert.equal(p.slug, "checkout-500s");
  assert.equal(p.title, "Checkout 500s");
  assert.equal(p.status, "open");
  assert.equal(p.severity, "high");
  assert.equal(p.openedBy, "chat");
  assert.equal(p.symptomStatement, "Checkout returns 500 for about 5% of requests since ~14:00 UTC.");
  assert.equal(p.symptomSignature, "checkout 500 error rate spike");
  assert.equal(p.affectedSurface, "checkout service");
  assert.equal(p.firstSeenAt, "2026-07-29T14:00:00Z");
  assert.equal(p.verdict, null);
  assert.equal(p.confidence, null);
  assert.equal(p.depthBudget, 8);
  assert.deepEqual(p.jaceSessionIds, ["sess-1"]);
  assert.equal(p.id, undefined, "the opaque db id is not carried into the projection");
  assert.equal(p.workspaceId, undefined);
  assert.equal(p.repositoryId, undefined);
});

test("projectInvestigation tolerates a missing/malformed raw investigation (never throws)", () => {
  const p = projectInvestigation(null);
  assert.equal(p.slug, "");
  assert.equal(p.title, "");
  assert.equal(p.symptomStatement, "");
  assert.deepEqual(p.jaceSessionIds, []);
});

test("projectInvestigation hardens title/symptomStatement/symptomSignature/affectedSurface", () => {
  const p = projectInvestigation(
    investigation({
      title: "click javascript:alert(1) ​now",
      symptomStatement: "see javascript:alert(2) ​here",
      symptomSignature: "see javascript:alert(3) ​here",
      affectedSurface: "see javascript:alert(4) ​here",
    }),
  );
  assert.match(p.title, /javascript\[:\]alert\(1\)/);
  assert.match(p.symptomStatement, /javascript\[:\]alert\(2\)/);
  assert.match(p.symptomSignature, /javascript\[:\]alert\(3\)/);
  assert.match(p.affectedSurface, /javascript\[:\]alert\(4\)/);
});

test("projectInvestigationWithItems attaches every item", () => {
  const raw = investigation({ items: [item({ id: "a" }), item({ id: "b" })] });
  const p = projectInvestigationWithItems(raw);
  assert.equal(p.items.length, 2);
  assert.equal(p.slug, "checkout-500s");
});

test("projectInvestigationWithItems tolerates a missing items array", () => {
  const p = projectInvestigationWithItems(investigation());
  assert.deepEqual(p.items, []);
});

test("projectInvestigations projects a body's investigations array (index rows, NO items key), tolerant of a missing/non-array field", () => {
  assert.deepEqual(projectInvestigations({}), []);
  assert.deepEqual(projectInvestigations(null), []);
  const list = projectInvestigations({
    investigations: [investigation({ slug: "a" }), investigation({ slug: "b" })],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].slug, "a");
  assert.equal(list[1].slug, "b");
  assert.equal("items" in list[0], false, "list/search rows never carry an items key — no fanout eligibility/detail");
});

// ---------------------------------------------------------------------------
// projectEligibility — relayed verbatim, absence is not a claim of eligibility
// ---------------------------------------------------------------------------

test("projectEligibility relays eligible:true with no blocking reasons", () => {
  assert.deepEqual(projectEligibility({ eligible: true, blocking: [] }), { eligible: true, blocking: [] });
});

test("projectEligibility relays eligible:false with the blocking reasons, hardened defensively", () => {
  const e = projectEligibility({
    eligible: false,
    blocking: ["no supported hypothesis with mechanism and evidence"],
  });
  assert.equal(e.eligible, false);
  assert.deepEqual(e.blocking, ["no supported hypothesis with mechanism and evidence"]);
});

test("projectEligibility returns undefined for a missing/malformed raw value — absence, not a claim", () => {
  assert.equal(projectEligibility(undefined), undefined);
  assert.equal(projectEligibility(null), undefined);
  assert.equal(projectEligibility("not an object"), undefined);
});

test("projectEligibility tolerates a non-array blocking field", () => {
  assert.deepEqual(projectEligibility({ eligible: false }), { eligible: false, blocking: [] });
});

// ---------------------------------------------------------------------------
// renderEligibility — the pinned two-way rendering
// ---------------------------------------------------------------------------

test("renderEligibility renders nothing (empty string) when eligibility is undefined", () => {
  assert.equal(renderEligibility(undefined), "");
});

test("renderEligibility renders the pinned 'Eligible for record_verdict.' line", () => {
  assert.equal(renderEligibility({ eligible: true, blocking: [] }), "Eligible for record_verdict.");
});

test("renderEligibility renders the pinned 'NOT eligible' line with blocking reasons joined by '; '", () => {
  const text = renderEligibility({
    eligible: false,
    blocking: ["no supported hypothesis with mechanism and evidence", "no refuted rival hypothesis and no solePlausible finding"],
  });
  assert.equal(
    text,
    "NOT eligible for record_verdict — no supported hypothesis with mechanism and evidence; no refuted rival hypothesis and no solePlausible finding",
  );
});

// ---------------------------------------------------------------------------
// renderList / renderInvestigationDetail / renderGet / renderSearch / renderAnchor
// ---------------------------------------------------------------------------

test("renderList carries the untrusted notice and names slug/title/status/severity", () => {
  const investigations = projectInvestigations({
    investigations: [investigation({ slug: "checkout-500s" }), investigation({ slug: "login-timeouts", verdict: "root_caused" })],
  });
  const text = renderList({ investigations });
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /- checkout-500s — Checkout 500s \[open\/high\]/);
  assert.match(text, /- login-timeouts — .* \[open\/high\].*verdict: root_caused/);
});

test("renderList handles no investigations honestly (no fabrication)", () => {
  const text = renderList({ investigations: [] });
  assert.match(text, /No investigations yet for this workspace\./);
});

test("renderInvestigationDetail renders title/status/severity/symptom/affectedSurface and every item — no eligibility (that's a separate render)", () => {
  const p = projectInvestigationWithItems(
    investigation({
      items: [item({ id: "a", kind: "hypothesis", body: "pool exhaustion" })],
    }),
  );
  const text = renderInvestigationDetail(p);
  assert.match(text, /Checkout 500s \(checkout-500s\) — status: open, severity: high/);
  assert.match(text, /Symptom: Checkout returns 500/);
  assert.match(text, /Affected surface: checkout service/);
  assert.match(text, /\[hypothesis\/open\].*pool exhaustion/);
  assert.doesNotMatch(text, /eligible for record_verdict/i, "eligibility is rendered separately, never inside renderInvestigationDetail");
});

test("renderInvestigationDetail says 'none recorded yet' when there are no items", () => {
  const p = projectInvestigationWithItems(investigation());
  const text = renderInvestigationDetail(p);
  assert.match(text, /Items: none recorded yet\./);
});

test("renderGet is honest when no investigation matched the slug — an expected outcome, not an error", () => {
  const text = renderGet({ slug: "nonexistent", investigation: undefined });
  assert.match(text, /No investigation found at slug "nonexistent"\./);
});

test("renderGet renders full detail plus eligibility when an investigation is found", () => {
  const p = projectInvestigationWithItems(investigation({ items: [item()] }));
  const text = renderGet({ slug: "checkout-500s", investigation: p, eligibility: { eligible: true, blocking: [] } });
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /Checkout 500s \(checkout-500s\)/);
  assert.match(text, /Eligible for record_verdict\./);
});

test("renderSearch renders every hit as a compact index line, in order, or an honest 'nothing matched' — no item detail (search returns none)", () => {
  const investigations = projectInvestigations({
    investigations: [investigation({ slug: "checkout-500s", title: "Checkout 500s" }), investigation({ slug: "login-timeouts", title: "Login timeouts" })],
  });
  const text = renderSearch({ query: "checkout", investigations });
  assert.match(text, /for "checkout" — 2 hit\(s\)\./);
  assert.ok(text.indexOf("checkout-500s") < text.indexOf("login-timeouts"));

  const empty = renderSearch({ query: "nope", investigations: [] });
  assert.match(empty, /No matching investigations\./);
});

test("renderAnchor is honest when nothing is anchored yet, and points at search next", () => {
  const text = renderAnchor({ investigation: null });
  assert.match(text, /no investigation anchored yet/i);
  assert.match(text, /mode="search"/);
});

test("renderAnchor renders the full anchored investigation plus eligibility plus the resume-don't-restart framing", () => {
  const p = projectInvestigationWithItems(investigation({ items: [item()] }));
  const text = renderAnchor({ investigation: p, eligibility: { eligible: false, blocking: ["x"] } });
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /resume from it, never restart/i);
  assert.match(text, /Checkout 500s \(checkout-500s\)/);
  assert.match(text, /NOT eligible for record_verdict — x/);
});

// ---------------------------------------------------------------------------
// fetchInvestigations — local validation guards (no wasted transport call)
// ---------------------------------------------------------------------------

test("fetchInvestigations: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ investigations: [] }));
  for (const badId of [undefined, "", "   "]) {
    const res = await fetchInvestigations({ eveSessionId: badId, mode: "list", env: ENV, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("fetchInvestigations: invalid mode -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ investigations: [] }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "delete", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchInvestigations: mode=get without slug -> degraded('missing_slug'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ investigations: [] }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "get", env: ENV, transport });
  assert.equal(res.reason, "missing_slug");
  assert.equal(transport.calls.length, 0);
});

test("fetchInvestigations: mode=search without query -> degraded('missing_query'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ investigations: [] }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "search", env: ENV, transport });
  assert.equal(res.reason, "missing_query");
  assert.equal(transport.calls.length, 0);
});

test("fetchInvestigations: unset console config -> degraded('config_missing') with missing vars, transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ investigations: [] }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: {}, transport });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// fetchInvestigations — transport / HTTP outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("fetchInvestigations: transport throws -> degraded('unreachable'), exactly one attempt, no leaked error text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("fetchInvestigations: mode=get 404 -> honest 'no investigation yet', NOT a degraded failure", async () => {
  const transport = fakeTransport(() => ({
    status: 404,
    json: async () => ({ error: "Investigation checkout-500s not found" }),
  }));
  const res = await fetchInvestigations({
    eveSessionId: EVE_SESSION_ID,
    mode: "get",
    slug: "checkout-500s",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.degraded, undefined);
  assert.equal(res.investigation, undefined);
  assert.match(res.rendered, /No investigation found at slug "checkout-500s"\./);
});

test("fetchInvestigations: mode=list 404 (session not found) -> degraded('not_found')", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Session not found" }) }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "not_found");
});

test("fetchInvestigations: degraded results never leak the bearer token", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
});

test("fetchInvestigations: non-JSON body on 200 -> degraded('bad_body')", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("fetchInvestigations: non-JSON body on a non-2xx status still maps to the status's reason, not bad_body", async () => {
  const transport = fakeTransport(() => ({
    status: 500,
    json: async () => {
      throw new SyntaxError("nope");
    },
  }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// fetchInvestigations — success, per mode
// ---------------------------------------------------------------------------

test("fetchInvestigations: mode=list success renders the index and sends the auth header", async () => {
  let seenInit = null;
  const body = {
    schemaVersion: 1,
    mode: "list",
    investigations: [investigation({ slug: "checkout-500s" }), investigation({ slug: "login-timeouts" })],
  };
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return okResponse(body);
  });
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "list");
  assert.equal(res.investigations.length, 2);
  assert.match(res.rendered, /- checkout-500s — Checkout 500s/);
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls.length, 1);
});

test("fetchInvestigations: mode=get success renders full detail + eligibility and passes slug through the URL", async () => {
  const body = {
    schemaVersion: 1,
    mode: "get",
    investigation: investigation(),
    items: [item()],
    eligibility: { eligible: false, blocking: ["no supported hypothesis with mechanism and evidence"] },
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({
    eveSessionId: EVE_SESSION_ID,
    mode: "get",
    slug: "checkout-500s",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.investigation.slug, "checkout-500s");
  assert.equal(res.investigation.items.length, 1);
  assert.deepEqual(res.eligibility, { eligible: false, blocking: ["no supported hypothesis with mechanism and evidence"] });
  assert.match(res.rendered, /Checkout 500s \(checkout-500s\)/);
  assert.match(res.rendered, /NOT eligible for record_verdict/);
  assert.match(transport.calls[0].url, /slug=checkout-500s/);
});

test("fetchInvestigations: mode=get relays eligible:true straight through", async () => {
  const body = {
    schemaVersion: 1,
    mode: "get",
    investigation: investigation(),
    items: [item()],
    eligibility: { eligible: true, blocking: [] },
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({
    eveSessionId: EVE_SESSION_ID,
    mode: "get",
    slug: "checkout-500s",
    env: ENV,
    transport,
  });
  assert.deepEqual(res.eligibility, { eligible: true, blocking: [] });
  assert.match(res.rendered, /Eligible for record_verdict\./);
});

test("fetchInvestigations: mode=get with NO eligibility in the body -> eligibility is undefined, not fabricated as eligible", async () => {
  const body = { schemaVersion: 1, mode: "get", investigation: investigation(), items: [item()] };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({
    eveSessionId: EVE_SESSION_ID,
    mode: "get",
    slug: "checkout-500s",
    env: ENV,
    transport,
  });
  assert.equal(res.eligibility, undefined);
  assert.doesNotMatch(res.rendered, /eligible for record_verdict/i);
});

test("fetchInvestigations: mode=search success renders every hit compactly and passes query through the URL", async () => {
  const body = {
    schemaVersion: 1,
    mode: "search",
    investigations: [investigation({ slug: "checkout-500s", title: "Checkout 500s" })],
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({
    eveSessionId: EVE_SESSION_ID,
    mode: "search",
    query: "checkout 500",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.match(res.rendered, /Checkout 500s/);
  assert.match(transport.calls[0].url, /query=checkout%20500/);
});

test("fetchInvestigations: malformed success body (no investigations array) -> empty investigations, not a throw", async () => {
  const transport = fakeTransport(() => okResponse({ nope: true }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.deepEqual(res.investigations, []);
});

// ---------------------------------------------------------------------------
// fetchInvestigations — mode=anchor: the FIRST call in the resolution order
// ---------------------------------------------------------------------------

test("fetchInvestigations: mode=anchor needs no slug/query — never blocked by missing_slug/missing_query", async () => {
  const transport = fakeTransport(() => okResponse({ schemaVersion: 1, mode: "anchor", investigation: null }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "anchor", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 1);
});

test("fetchInvestigations: mode=anchor, nothing anchored -> investigation:null (flat, no wrapper key), an honest outcome not a degraded one", async () => {
  const transport = fakeTransport(() => okResponse({ schemaVersion: 1, mode: "anchor", investigation: null }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "anchor", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.degraded, undefined);
  assert.equal(res.investigation, null);
  assert.match(res.rendered, /no investigation anchored yet/i);
});

test("fetchInvestigations: mode=anchor, an investigation IS anchored -> flat investigation/items/eligibility, same projection as mode=get", async () => {
  const body = {
    schemaVersion: 1,
    mode: "anchor",
    investigation: investigation(),
    items: [item()],
    eligibility: { eligible: true, blocking: [] },
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "anchor", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.investigation.slug, "checkout-500s");
  assert.equal(res.investigation.items.length, 1);
  assert.deepEqual(res.eligibility, { eligible: true, blocking: [] });
  assert.match(res.rendered, /resume from it, never restart/i);
});

test("fetchInvestigations: mode=anchor with NO eligibility in the body -> eligibility undefined, not fabricated", async () => {
  const body = { schemaVersion: 1, mode: "anchor", investigation: investigation(), items: [item()] };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "anchor", env: ENV, transport });
  assert.equal(res.eligibility, undefined);
  assert.doesNotMatch(res.rendered, /eligible for record_verdict/i);
});

test("fetchInvestigations: mode=anchor, session not found (404) -> degraded('not_found'), not the honest-null path", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Session not found" }) }));
  const res = await fetchInvestigations({ eveSessionId: EVE_SESSION_ID, mode: "anchor", env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "not_found");
});

// ---------------------------------------------------------------------------
// End-to-end hardening of hostile content
// ---------------------------------------------------------------------------

test("fetchInvestigations: a hostile title (zero-width chars, @everyone, javascript: URL) renders inert end-to-end", async () => {
  const body = {
    schemaVersion: 1,
    mode: "get",
    investigation: investigation({
      title: "@everyone click javascript:alert(1) ​now",
    }),
    items: [],
    eligibility: { eligible: false, blocking: ["no supported hypothesis with mechanism and evidence"] },
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchInvestigations({
    eveSessionId: EVE_SESSION_ID,
    mode: "get",
    slug: "checkout-500s",
    env: ENV,
    transport,
  });
  assert.doesNotMatch(res.rendered, /​/);
  assert.doesNotMatch(res.rendered, /(^|[^0-9A-Za-z_])@everyone\b/);
  assert.doesNotMatch(res.rendered, /javascript:alert/);
  assert.match(res.rendered, /javascript\[:\]alert\(1\)/);
});
