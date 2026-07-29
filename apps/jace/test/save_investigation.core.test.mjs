// Unit tests for the investigation-save core (Jace's UNGATED write path into
// INVESTIGATIONS). No SDK, no live network: the single HTTP call is an
// injected `transport` seam, so every branch — success and each
// degraded/refused outcome — is exercised deterministically. Mirrors
// save_brief.core.test.mjs's fakeTransport pattern; see
// agent/lib/save_investigation.core.mjs for the module doc-comment covering
// the seven-array refusal contract this suite guards hardest.
//
// The two things this suite guards hardest, because they are the exact
// failure class briefs/investigations both exist to eliminate (a caller
// believing something was recorded when it wasn't):
//   1. All SIX skip/unmatched arrays are ALWAYS present on a success result
//      (even empty), and `renderSaved` names each with its PINNED prefix
//      whenever it is non-empty.
//   2. This module has NO `verdict`/`status` parameter anywhere in its input
//      shape — not "accepted and dropped", genuinely absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_INVESTIGATION_PATH,
  INVESTIGATION_SEVERITIES,
  INVESTIGATION_ITEM_KINDS,
  HYPOTHESIS_STATES,
  INVESTIGATION_LINK_ROLES,
  resolveConsoleConfig,
  buildSaveInvestigationUrl,
  classifyStatus,
  degraded,
  sanitizeItem,
  sanitizeLink,
  renderSaved,
  renderAnchorCleared,
  saveInvestigation,
} from "../agent/lib/save_investigation.core.mjs";

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

function investigationBody(overrides = {}) {
  return {
    id: "inv-uuid-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "checkout-500s",
    title: "Checkout 500s",
    status: "open",
    severity: "high",
    openedBy: "chat",
    symptomStatement: "Checkout returns 500 for about 5% of requests.",
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

function successResponse(overrides = {}) {
  return {
    status: 200,
    json: async () => ({
      investigation: investigationBody(),
      applied: ["item-1"],
      skippedHumanAuthorityIds: [],
      skippedEvidenceImmutableIds: [],
      skippedHypothesisNeedsEvidence: [],
      skippedKindChangeIds: [],
      unmatchedIds: [],
      skippedLinks: [],
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Enums mirror the console route's own hand-rolled contract
// ---------------------------------------------------------------------------

test("INVESTIGATION_SEVERITIES/INVESTIGATION_ITEM_KINDS/HYPOTHESIS_STATES/INVESTIGATION_LINK_ROLES match the console route's contract", () => {
  assert.deepEqual(INVESTIGATION_SEVERITIES, ["low", "medium", "high", "critical"]);
  assert.deepEqual(INVESTIGATION_ITEM_KINDS, [
    "timeline_event",
    "evidence",
    "hypothesis",
    "finding",
    "verdict",
    "lesson_candidate",
  ]);
  assert.deepEqual(HYPOTHESIS_STATES, ["open", "supported", "refuted", "inconclusive"]);
  assert.deepEqual(INVESTIGATION_LINK_ROLES, ["recurrence_of", "related"]);
});

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildSaveInvestigationUrl
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
});

test("buildSaveInvestigationUrl carries nothing in the URL — everything rides in the POST body", () => {
  assert.equal(buildSaveInvestigationUrl("https://c.example.com"), `https://c.example.com${SAVE_INVESTIGATION_PATH}`);
});

// ---------------------------------------------------------------------------
// classifyStatus / degraded
// ---------------------------------------------------------------------------

test("classifyStatus maps HTTP status to outcome, including 422 -> content_rejected", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(422), { ok: false, reason: "content_rejected" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded carries a stable reason + cause-free note, and extra fields ride along", () => {
  const d = degraded("content_rejected", { message: "Investigation content rejected", detail: "blocked 1 secret-shaped value(s)" });
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "content_rejected");
  assert.ok(d.note.length > 0);
  assert.equal(d.message, "Investigation content rejected");
});

test("degraded('missing_slug') tells the caller to reuse or propose a slug", () => {
  assert.match(degraded("missing_slug").note, /reuse an existing investigation's slug/i);
});

// ---------------------------------------------------------------------------
// sanitizeItem — the load-bearing evidence_refs -> evidenceRefs mapping
// ---------------------------------------------------------------------------

test("sanitizeItem requires kind on the wire, and hardens body/mechanism", () => {
  const out = sanitizeItem({ kind: "hypothesis", body: "pool exhaustion", mechanism: "starves under load" });
  assert.deepEqual(out, { kind: "hypothesis", body: "pool exhaustion", mechanism: "starves under load" });
});

test("sanitizeItem only carries fields the caller actually supplied — omitted id/body/mechanism/state/evidenceRefs/data are absent, not undefined", () => {
  const out = sanitizeItem({ kind: "timeline_event" });
  assert.deepEqual(out, { kind: "timeline_event" });
  assert.equal("id" in out, false);
  assert.equal("body" in out, false);
  assert.equal("state" in out, false);
  assert.equal("evidenceRefs" in out, false);
  assert.equal("data" in out, false);
});

test("sanitizeItem maps the model-facing evidence_refs field to the wire's evidenceRefs — the load-bearing rename", () => {
  const out = sanitizeItem({ kind: "hypothesis", evidence_refs: ["ev-1", "ev-2"] });
  assert.deepEqual(out.evidenceRefs, ["ev-1", "ev-2"]);
  assert.equal("evidence_refs" in out, false, "the model-facing snake_case name must never ride onto the wire");
});

test("sanitizeItem preserves an explicit null state (distinct from omitted)", () => {
  const out = sanitizeItem({ kind: "hypothesis", state: null });
  assert.equal("state" in out, true);
  assert.equal(out.state, null);
});

test("sanitizeItem preserves an explicit empty evidence_refs array (distinct from omitted)", () => {
  const out = sanitizeItem({ kind: "hypothesis", evidence_refs: [] });
  assert.deepEqual(out.evidenceRefs, []);
});

test("sanitizeItem carries id and data through untouched when supplied", () => {
  const out = sanitizeItem({ id: "item-9", kind: "finding", data: { solePlausible: true } });
  assert.equal(out.id, "item-9");
  assert.deepEqual(out.data, { solePlausible: true });
});

test("sanitizeItem runs body/mechanism through hardenUntrusted", () => {
  const out = sanitizeItem({
    kind: "hypothesis",
    body: "see javascript:alert(1) ​ here",
    mechanism: "click javascript:alert(2) ​ now",
  });
  assert.match(out.body, /javascript\[:\]alert\(1\)/);
  assert.match(out.mechanism, /javascript\[:\]alert\(2\)/);
});

// ---------------------------------------------------------------------------
// sanitizeLink
// ---------------------------------------------------------------------------

test("sanitizeLink carries targetSlug + role straight through", () => {
  assert.deepEqual(sanitizeLink({ targetSlug: "login-timeouts", role: "recurrence_of" }), {
    targetSlug: "login-timeouts",
    role: "recurrence_of",
  });
});

// ---------------------------------------------------------------------------
// renderSaved — the seven arrays, six with PINNED refusal prefixes
// ---------------------------------------------------------------------------

test("renderSaved reports a clean save plainly when every refusal array is empty", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: ["item-1", "item-2"],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: [],
    unmatchedIds: [],
    skippedLinks: [],
  });
  assert.match(text, /Saved investigation "checkout-500s" — 2 item\(s\) written\./);
  assert.doesNotMatch(text, /REFUSED/);
  assert.doesNotMatch(text, /UNMATCHED/);
  assert.doesNotMatch(text, /SKIPPED LINK/);
});

test("renderSaved names skippedHumanAuthorityIds with the pinned 'REFUSED (human-locked):' prefix", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: ["item-9"],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: [],
    unmatchedIds: [],
    skippedLinks: [],
  });
  assert.match(text, /REFUSED \(human-locked\):/);
  assert.match(text, /item-9/);
  assert.match(text, /human edits win/i);
});

test("renderSaved names skippedEvidenceImmutableIds with the pinned 'REFUSED (evidence immutable):' prefix", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: ["item-3"],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: [],
    unmatchedIds: [],
    skippedLinks: [],
  });
  assert.match(text, /REFUSED \(evidence immutable\):/);
  assert.match(text, /item-3/);
});

test("renderSaved names skippedHypothesisNeedsEvidence with the pinned 'REFUSED (hypothesis needs evidence):' prefix", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: ["item-4"],
    skippedKindChangeIds: [],
    unmatchedIds: [],
    skippedLinks: [],
  });
  assert.match(text, /REFUSED \(hypothesis needs evidence\):/);
  assert.match(text, /item-4/);
});

test("renderSaved names skippedKindChangeIds with the pinned 'REFUSED (kind is fixed at creation):' prefix", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: ["item-5"],
    unmatchedIds: [],
    skippedLinks: [],
  });
  assert.match(text, /REFUSED \(kind is fixed at creation\):/);
  assert.match(text, /item-5/);
});

test("renderSaved names unmatchedIds with the pinned 'UNMATCHED (no such item in this investigation):' prefix", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: [],
    unmatchedIds: ["item-6"],
    skippedLinks: [],
  });
  assert.match(text, /UNMATCHED \(no such item in this investigation\):/);
  assert.match(text, /item-6/);
});

test("renderSaved names skippedLinks with the pinned 'SKIPPED LINK (target not found):' prefix", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: [],
    unmatchedIds: [],
    skippedLinks: ["some-missing-slug"],
  });
  assert.match(text, /SKIPPED LINK \(target not found\):/);
  assert.match(text, /some-missing-slug/);
});

test("renderSaved names ALL SIX refusal arrays at once when every one is non-empty", () => {
  const text = renderSaved({
    investigation: { slug: "checkout-500s" },
    applied: ["item-1"],
    skippedHumanAuthorityIds: ["a"],
    skippedEvidenceImmutableIds: ["b"],
    skippedHypothesisNeedsEvidence: ["c"],
    skippedKindChangeIds: ["d"],
    unmatchedIds: ["e"],
    skippedLinks: ["f"],
  });
  assert.match(text, /REFUSED \(human-locked\):/);
  assert.match(text, /REFUSED \(evidence immutable\):/);
  assert.match(text, /REFUSED \(hypothesis needs evidence\):/);
  assert.match(text, /REFUSED \(kind is fixed at creation\):/);
  assert.match(text, /UNMATCHED \(no such item in this investigation\):/);
  assert.match(text, /SKIPPED LINK \(target not found\):/);
});

test("renderSaved says nothing about the anchor when this call didn't touch it, and names it when it did", () => {
  const base = {
    investigation: { slug: "checkout-500s" },
    applied: [],
    skippedHumanAuthorityIds: [],
    skippedEvidenceImmutableIds: [],
    skippedHypothesisNeedsEvidence: [],
    skippedKindChangeIds: [],
    unmatchedIds: [],
    skippedLinks: [],
  };
  assert.doesNotMatch(renderSaved(base), /anchor/i);
  assert.match(renderSaved({ ...base, anchor: { investigationId: "inv-uuid-1" } }), /now anchored to this investigation/i);
  assert.match(renderSaved({ ...base, anchor: null }), /anchor was cleared/i);
});

test("renderAnchorCleared describes a pure anchor-clear with nothing touched, and points at re-resolving via fetch_investigations", () => {
  const text = renderAnchorCleared();
  assert.match(text, /cleared this conversation's investigation anchor/i);
  assert.match(text, /nothing was written or touched/i);
  assert.match(text, /fetch_investigations/);
});

// ---------------------------------------------------------------------------
// saveInvestigation — local validation guards (no wasted transport call)
// ---------------------------------------------------------------------------

test("saveInvestigation: unset console config -> degraded('config_missing'), transport never called", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: {}, transport });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

test("saveInvestigation: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => successResponse());
  for (const badId of [undefined, "", "   "]) {
    const res = await saveInvestigation({ eveSessionId: badId, slug: "checkout-500s", env: ENV, transport });
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("saveInvestigation: blank slug (not a pure anchor clear) -> degraded('missing_slug'), transport never called", async () => {
  const transport = fakeTransport(() => successResponse());
  for (const badSlug of [undefined, "", "   "]) {
    const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: badSlug, env: ENV, transport });
    assert.equal(res.reason, "missing_slug");
  }
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// saveInvestigation — anchor plumbing
// ---------------------------------------------------------------------------

test("saveInvestigation: a pure { anchor: false } clear with no slug is ALLOWED, not degraded('missing_slug')", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ anchor: null }) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, anchor: false, env: ENV, transport });
  assert.equal(res.degraded, undefined);
  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 1);
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, { eveSessionId: EVE_SESSION_ID, anchor: false });
});

test("saveInvestigation: { anchor: false } with content fields but no slug is STILL degraded('missing_slug') — not a pure clear", async () => {
  const transport = fakeTransport(() => successResponse());
  for (const extra of [
    { title: "Checkout 500s" },
    { symptomStatement: "checkout is 500ing" },
    { items: [{ kind: "timeline_event", body: "x" }] },
    { links: [{ targetSlug: "login-timeouts", role: "related" }] },
  ]) {
    const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, anchor: false, ...extra, env: ENV, transport });
    assert.equal(res.reason, "missing_slug", `expected missing_slug for ${JSON.stringify(extra)}`);
  }
  assert.equal(transport.calls.length, 0);
});

test("saveInvestigation: anchor:true still requires slug like any other write", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, anchor: true, env: ENV, transport });
  assert.equal(res.reason, "missing_slug");
  assert.equal(transport.calls.length, 0);
});

test("saveInvestigation: anchor rides in the POST body only when the caller actually supplied it", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", anchor: true, env: ENV, transport });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.equal(sentBody.anchor, true);

  await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  const sentBody2 = JSON.parse(transport.calls[1].init.body);
  assert.equal("anchor" in sentBody2, false, "omitted anchor must not ride as undefined/null");
});

test("saveInvestigation: success on a pure anchor clear (no investigation in the body) returns ok:true with every array present-but-empty", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ anchor: null }) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, anchor: false, env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.anchor, null);
  assert.equal(res.investigation, undefined);
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.skippedHumanAuthorityIds, []);
  assert.deepEqual(res.skippedEvidenceImmutableIds, []);
  assert.deepEqual(res.skippedHypothesisNeedsEvidence, []);
  assert.deepEqual(res.skippedKindChangeIds, []);
  assert.deepEqual(res.unmatchedIds, []);
  assert.deepEqual(res.skippedLinks, []);
  assert.match(res.rendered, /cleared this conversation's investigation anchor/i);
});

test("saveInvestigation: a body with neither investigation nor anchor -> degraded('bad_body') rather than a silent pure-clear guess", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ nope: true }) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, anchor: false, env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("saveInvestigation: a normal write echoes anchor:true back as { investigationId } when the console set it", async () => {
  const transport = fakeTransport(() => successResponse({ anchor: { investigationId: "inv-uuid-1" } }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", anchor: true, env: ENV, transport });
  assert.deepEqual(res.anchor, { investigationId: "inv-uuid-1" });
  assert.match(res.rendered, /now anchored to this investigation/i);
});

test("saveInvestigation: a normal write that clears the anchor alongside content echoes anchor:null back", async () => {
  const transport = fakeTransport(() => successResponse({ anchor: null }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", anchor: false, env: ENV, transport });
  assert.equal(res.anchor, null);
  assert.match(res.rendered, /anchor was cleared/i);
});

test("saveInvestigation: a normal write that never touched the anchor has NO anchor key on the result at all", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal("anchor" in res, false);
});

// ---------------------------------------------------------------------------
// saveInvestigation — request shape: no `verdict`/`status`, ever; items REQUIRE kind
// ---------------------------------------------------------------------------

test("saveInvestigation: the POST body NEVER carries verdict or status fields — there is no parameter for either", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveInvestigation({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    title: "Checkout 500s",
    env: ENV,
    transport,
  });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.equal("verdict" in sentBody, false);
  assert.equal("status" in sentBody, false);
});

test("saveInvestigation: omitted title/symptomStatement/severity/items/links are OMITTED from the body, not sent as null/undefined", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, { eveSessionId: EVE_SESSION_ID, slug: "checkout-500s" });
});

test("saveInvestigation: items ride as a sanitized delta with evidence_refs mapped to evidenceRefs, and every item still carries kind", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveInvestigation({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    items: [
      { id: "item-1", kind: "hypothesis", state: "supported", evidence_refs: ["ev-1"] },
      { kind: "timeline_event", body: "deploy at 14:00 UTC" },
    ],
    env: ENV,
    transport,
  });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody.items, [
    { id: "item-1", kind: "hypothesis", state: "supported", evidenceRefs: ["ev-1"] },
    { kind: "timeline_event", body: "deploy at 14:00 UTC" },
  ]);
});

test("saveInvestigation: links ride straight through as { targetSlug, role }", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveInvestigation({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    links: [{ targetSlug: "login-timeouts", role: "related" }],
    env: ENV,
    transport,
  });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody.links, [{ targetSlug: "login-timeouts", role: "related" }]);
});

test("saveInvestigation: severity/firstSeenAt/symptomSignature/affectedSurface ride through when supplied", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveInvestigation({
    eveSessionId: EVE_SESSION_ID,
    slug: "checkout-500s",
    severity: "critical",
    firstSeenAt: "2026-07-29T14:00:00Z",
    symptomSignature: "checkout 500 spike",
    affectedSurface: "checkout",
    env: ENV,
    transport,
  });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.equal(sentBody.severity, "critical");
  assert.equal(sentBody.firstSeenAt, "2026-07-29T14:00:00Z");
  assert.equal(sentBody.symptomSignature, "checkout 500 spike");
  assert.equal(sentBody.affectedSurface, "checkout");
});

test("saveInvestigation: sends the auth + content-type headers", async () => {
  let seenInit = null;
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return successResponse();
  });
  await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", title: "Checkout 500s", env: ENV, transport });
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(seenInit.headers["Content-Type"], "application/json");
});

// ---------------------------------------------------------------------------
// saveInvestigation — transport / HTTP outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("saveInvestigation: transport throws -> degraded('unreachable'), exactly one attempt, no leaked error text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("saveInvestigation: 400 relays the console's own error message verbatim (e.g. verdict/status rejection)", async () => {
  const transport = fakeTransport(() => ({
    status: 400,
    json: async () => ({
      error: "verdict and status never travel through save — use /investigations/verdict; status is derived",
    }),
  }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.match(res.message, /verdict and status never travel through save/);
});

test("saveInvestigation: 401/403 -> degraded('unauthorized')", async () => {
  const transport = fakeTransport(() => ({ status: 401, json: async () => ({}) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.reason, "unauthorized");
});

test("saveInvestigation: 404 -> degraded('not_found')", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Session not found" }) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.reason, "not_found");
});

test("saveInvestigation: 422 (secret scan) -> degraded('content_rejected') never throws, core is never called on the offending value again", async () => {
  const transport = fakeTransport(() => ({
    status: 422,
    json: async () => ({
      error: "Investigation content rejected: credential-shaped value detected",
      reason: "blocked 1 secret-shaped value(s): aws_access_key_id",
    }),
  }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.reason, "content_rejected");
  assert.equal(res.message, "Investigation content rejected: credential-shaped value detected");
  assert.equal(res.detail, "blocked 1 secret-shaped value(s): aws_access_key_id");
  assert.match(res.note, /never retry/i);
});

test("saveInvestigation: 500 -> degraded('upstream_error')", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
});

test("saveInvestigation: non-JSON body on 200 -> degraded('bad_body'), unconfirmed not assumed-successful", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("saveInvestigation: degraded results never leak the bearer token", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
});

// ---------------------------------------------------------------------------
// saveInvestigation — success, and all six refusal arrays are ALWAYS present
// ---------------------------------------------------------------------------

test("saveInvestigation: success returns investigation + applied + all six refusal arrays present (even empty), plus a rendered summary", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", title: "Checkout 500s", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.investigation.slug, "checkout-500s");
  assert.deepEqual(res.applied, ["item-1"]);
  assert.deepEqual(res.skippedHumanAuthorityIds, []);
  assert.deepEqual(res.skippedEvidenceImmutableIds, []);
  assert.deepEqual(res.skippedHypothesisNeedsEvidence, []);
  assert.deepEqual(res.skippedKindChangeIds, []);
  assert.deepEqual(res.unmatchedIds, []);
  assert.deepEqual(res.skippedLinks, []);
  assert.match(res.rendered, /Saved investigation "checkout-500s" — 1 item\(s\) written\./);
});

test("saveInvestigation: success carries every refusal array through verbatim (as ids) and renders each with its pinned prefix", async () => {
  const transport = fakeTransport(() =>
    successResponse({
      skippedHumanAuthorityIds: ["item-9"],
      skippedEvidenceImmutableIds: ["item-3"],
      skippedHypothesisNeedsEvidence: ["item-4"],
      skippedKindChangeIds: ["item-5"],
      unmatchedIds: ["item-6"],
      skippedLinks: ["missing-slug"],
    }),
  );
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.deepEqual(res.skippedHumanAuthorityIds, ["item-9"]);
  assert.deepEqual(res.skippedEvidenceImmutableIds, ["item-3"]);
  assert.deepEqual(res.skippedHypothesisNeedsEvidence, ["item-4"]);
  assert.deepEqual(res.skippedKindChangeIds, ["item-5"]);
  assert.deepEqual(res.unmatchedIds, ["item-6"]);
  assert.deepEqual(res.skippedLinks, ["missing-slug"]);
  assert.match(res.rendered, /REFUSED \(human-locked\)/);
  assert.match(res.rendered, /REFUSED \(evidence immutable\)/);
  assert.match(res.rendered, /REFUSED \(hypothesis needs evidence\)/);
  assert.match(res.rendered, /REFUSED \(kind is fixed at creation\)/);
  assert.match(res.rendered, /UNMATCHED \(no such item in this investigation\)/);
  assert.match(res.rendered, /SKIPPED LINK \(target not found\)/);
});

test("saveInvestigation: skippedEvidenceImmutableIds/skippedHypothesisNeedsEvidence may carry a brand-new item's body (no id yet) — hardened defensively", async () => {
  const transport = fakeTransport(() =>
    successResponse({
      skippedEvidenceImmutableIds: ["see javascript:alert(1) ​ here"],
    }),
  );
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.match(res.skippedEvidenceImmutableIds[0], /javascript\[:\]alert\(1\)/);
});

test("saveInvestigation: success projects the returned investigation through the same hardening fetch_investigations applies on the read side", async () => {
  const transport = fakeTransport(() =>
    successResponse({
      investigation: investigationBody({ title: "click javascript:alert(1) ​ now" }),
    }),
  );
  const res = await saveInvestigation({ eveSessionId: EVE_SESSION_ID, slug: "checkout-500s", env: ENV, transport });
  assert.match(res.investigation.title, /javascript\[:\]alert\(1\)/);
});
