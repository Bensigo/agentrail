// Unit tests for the brief-save core (Jace's UNGATED autosave write path into
// briefs). No SDK, no live network: the single HTTP call is an injected
// `transport` seam, so every branch — success and each degraded/refused
// outcome — is exercised deterministically. Mirrors post_pr_review.core.test.mjs's
// fakeTransport pattern and create_workspace.core.mjs's POST-body assertions.
//
// The two things this suite guards hardest, because they are the exact
// failure class briefs exist to eliminate (a caller believing something was
// recorded when it wasn't):
//   1. `skippedHumanAuthorityIds` / `skippedUnknownResolvedIds` are ALWAYS
//      present on a success result (even empty), and `renderSaved` names them
//      explicitly in plain language whenever either is non-empty.
//   2. This module has NO `status` parameter anywhere in its input shape —
//      not "accepted and dropped", genuinely absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_BRIEF_PATH,
  BRIEF_AREAS,
  BRIEF_ITEM_KINDS,
  BRIEF_ITEM_STATES,
  BRIEF_ITEM_RESOLUTIONS,
  resolveConsoleConfig,
  buildSaveBriefUrl,
  classifyStatus,
  degraded,
  sanitizeItem,
  renderSaved,
  renderAnchorCleared,
  saveBrief,
} from "../agent/lib/save_brief.core.mjs";

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

function briefBody(overrides = {}) {
  return {
    id: "brief-uuid-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "blog",
    title: "Add a blog",
    status: "draft",
    openQuestion: "Who can publish posts?",
    grounding: { wikiPageSlugs: [], memoryItemIds: [], commitSha: null },
    jaceSessionIds: ["sess-1"],
    createdAt: "2026-07-27T14:57:00Z",
    updatedAt: "2026-07-27T15:10:00Z",
    ...overrides,
  };
}

function successResponse(overrides = {}) {
  return {
    status: 200,
    json: async () => ({
      brief: briefBody(),
      items: [
        {
          id: "item-1",
          area: "problem",
          statement: "Readers need a way to publish posts.",
          evidence: "we want a blog",
          kind: "required",
          state: "open",
          resolution: null,
          authority: "jace",
        },
      ],
      skippedHumanAuthorityIds: [],
      skippedUnknownResolvedIds: [],
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Enums mirror the console route's own hand-rolled contract
// ---------------------------------------------------------------------------

test("BRIEF_AREAS/BRIEF_ITEM_KINDS/BRIEF_ITEM_STATES/BRIEF_ITEM_RESOLUTIONS match the console route's contract", () => {
  assert.deepEqual(BRIEF_AREAS, ["problem", "users", "constraints", "scope", "success-signal"]);
  assert.deepEqual(BRIEF_ITEM_KINDS, ["required", "optional", "unknown", "out-of-scope"]);
  assert.deepEqual(BRIEF_ITEM_STATES, ["open", "resolved"]);
  assert.deepEqual(BRIEF_ITEM_RESOLUTIONS, ["implemented", "deferred", "rejected", "satisfied-elsewhere"]);
});

// ---------------------------------------------------------------------------
// resolveConsoleConfig / buildSaveBriefUrl
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

test("buildSaveBriefUrl carries nothing in the URL — everything rides in the POST body", () => {
  assert.equal(buildSaveBriefUrl("https://c.example.com"), `https://c.example.com${SAVE_BRIEF_PATH}`);
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
  const d = degraded("content_rejected", { message: "Brief content rejected", detail: "blocked 1 secret-shaped value(s): aws_access_key_id" });
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "content_rejected");
  assert.ok(d.note.length > 0);
  assert.equal(d.message, "Brief content rejected");
  assert.equal(d.detail, "blocked 1 secret-shaped value(s): aws_access_key_id");
});

test("degraded('missing_slug') tells the caller to reuse or propose a slug", () => {
  assert.match(degraded("missing_slug").note, /reuse an existing brief's slug/i);
});

// ---------------------------------------------------------------------------
// sanitizeItem — hardening + partial-field pass-through
// ---------------------------------------------------------------------------

test("sanitizeItem hardens statement/evidence and only carries fields the caller actually supplied", () => {
  const out = sanitizeItem({ area: "problem", statement: "Needs auth.", kind: "required" });
  assert.deepEqual(out, { area: "problem", statement: "Needs auth.", kind: "required" });
  assert.equal("id" in out, false, "omitted id must not ride as undefined");
  assert.equal("evidence" in out, false);
  assert.equal("state" in out, false);
  assert.equal("resolution" in out, false);
});

test("sanitizeItem carries id/evidence/state/resolution when the caller supplies them, including explicit null resolution", () => {
  const out = sanitizeItem({
    id: "item-1",
    area: "scope",
    statement: "Ship v1 without comments.",
    evidence: "no comments for now",
    kind: "optional",
    state: "resolved",
    resolution: null,
  });
  assert.equal(out.id, "item-1");
  assert.equal(out.evidence, "no comments for now");
  assert.equal(out.state, "resolved");
  assert.equal(out.resolution, null);
});

test("sanitizeItem runs statement/evidence through hardenUntrusted", () => {
  const out = sanitizeItem({
    area: "problem",
    statement: "see javascript:alert(1) ​here",
    evidence: "click javascript:alert(2) ​now",
    kind: "required",
  });
  assert.match(out.statement, /javascript\[:\]alert\(1\)/);
  assert.match(out.evidence, /javascript\[:\]alert\(2\)/);
});

// ---------------------------------------------------------------------------
// renderSaved — the two refusal fields must be named explicitly, never silent
// ---------------------------------------------------------------------------

test("renderSaved reports a clean save plainly when both refusal arrays are empty", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [{ id: "1" }, { id: "2" }],
    skippedHumanAuthorityIds: [],
    skippedUnknownResolvedIds: [],
  });
  assert.match(text, /Saved brief "blog" — 2 item\(s\) written\./);
  assert.doesNotMatch(text, /REFUSED/);
});

test("renderSaved names skippedHumanAuthorityIds explicitly and says human edits win", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [],
    skippedHumanAuthorityIds: ["item-9"],
    skippedUnknownResolvedIds: [],
  });
  assert.match(text, /REFUSED \(human-locked\)/);
  assert.match(text, /item-9/);
  assert.match(text, /Human edits win/);
  assert.match(text, /do not tell the user these changes were saved/i);
});

test("renderSaved names skippedUnknownResolvedIds explicitly and explains the fix", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [],
    skippedHumanAuthorityIds: [],
    skippedUnknownResolvedIds: ["item-7"],
  });
  assert.match(text, /REFUSED \(unknown can't resolve\)/);
  assert.match(text, /item-7/);
  assert.match(text, /answer it first/i);
  assert.match(text, /out-of-scope/);
});

test("renderSaved says nothing about the anchor when this call didn't touch it", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [],
    skippedHumanAuthorityIds: [],
    skippedUnknownResolvedIds: [],
  });
  assert.doesNotMatch(text, /anchor/i);
});

test("renderSaved names the anchor set when anchor is truthy", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [],
    skippedHumanAuthorityIds: [],
    skippedUnknownResolvedIds: [],
    anchor: { briefId: "brief-uuid-1" },
  });
  assert.match(text, /now anchored to this brief/i);
});

test("renderSaved names the anchor clear when anchor is null", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [],
    skippedHumanAuthorityIds: [],
    skippedUnknownResolvedIds: [],
    anchor: null,
  });
  assert.match(text, /anchor was cleared/i);
});

test("renderAnchorCleared describes a pure anchor-clear with no brief touched, and points at re-resolving", () => {
  const text = renderAnchorCleared();
  assert.match(text, /cleared this conversation's brief anchor/i);
  assert.match(text, /no brief was written or touched/i);
  assert.match(text, /fetch_briefs/);
});

test("renderSaved names BOTH refusal arrays when both are non-empty", () => {
  const text = renderSaved({
    brief: { slug: "blog" },
    items: [{ id: "1" }],
    skippedHumanAuthorityIds: ["item-9"],
    skippedUnknownResolvedIds: ["item-7"],
  });
  assert.match(text, /human-locked/);
  assert.match(text, /unknown can't resolve/);
});

// ---------------------------------------------------------------------------
// saveBrief — local validation guards (no wasted transport call)
// ---------------------------------------------------------------------------

test("saveBrief: unset console config -> degraded('config_missing'), transport never called", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", env: {}, transport });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

test("saveBrief: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => successResponse());
  for (const badId of [undefined, "", "   "]) {
    const res = await saveBrief({ eveSessionId: badId, slug: "blog", env: ENV, transport });
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("saveBrief: blank slug -> degraded('missing_slug'), transport never called", async () => {
  const transport = fakeTransport(() => successResponse());
  for (const badSlug of [undefined, "", "   "]) {
    const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: badSlug, env: ENV, transport });
    assert.equal(res.reason, "missing_slug");
  }
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// saveBrief — anchor plumbing (design spec "confirm once, then anchor" /
// "re-confirm on drift")
// ---------------------------------------------------------------------------

test("saveBrief: a pure { anchor: false } clear with no slug is ALLOWED, not degraded('missing_slug')", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ anchor: null }) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, anchor: false, env: ENV, transport });
  assert.equal(res.degraded, undefined);
  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 1);
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, { eveSessionId: EVE_SESSION_ID, anchor: false });
});

test("saveBrief: { anchor: false } with content fields but no slug is STILL degraded('missing_slug') — not a pure clear", async () => {
  const transport = fakeTransport(() => successResponse());
  for (const extra of [{ title: "Add a blog" }, { openQuestion: "who approves?" }, { items: [{ area: "problem", statement: "x", kind: "required" }] }]) {
    const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, anchor: false, ...extra, env: ENV, transport });
    assert.equal(res.reason, "missing_slug", `expected missing_slug for ${JSON.stringify(extra)}`);
  }
  assert.equal(transport.calls.length, 0);
});

test("saveBrief: anchor:true still requires slug like any other write", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, anchor: true, env: ENV, transport });
  assert.equal(res.reason, "missing_slug");
  assert.equal(transport.calls.length, 0);
});

test("saveBrief: anchor rides in the POST body only when the caller actually supplied it", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", anchor: true, env: ENV, transport });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.equal(sentBody.anchor, true);

  await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", env: ENV, transport });
  const sentBody2 = JSON.parse(transport.calls[1].init.body);
  assert.equal("anchor" in sentBody2, false, "omitted anchor must not ride as undefined/null");
});

test("saveBrief: success on a pure anchor clear (no brief in the body) returns { ok:true, anchor: null } via renderAnchorCleared", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ anchor: null }) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, anchor: false, env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.anchor, null);
  assert.equal(res.brief, undefined);
  assert.deepEqual(res.skippedHumanAuthorityIds, []);
  assert.deepEqual(res.skippedUnknownResolvedIds, []);
  assert.match(res.rendered, /cleared this conversation's brief anchor/i);
});

test("saveBrief: a body with neither brief nor anchor -> degraded('bad_body') rather than a silent pure-clear guess", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ nope: true }) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, anchor: false, env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("saveBrief: a normal write echoes anchor:true back in the result when the console set it", async () => {
  const transport = fakeTransport(() =>
    successResponse({ anchor: { briefId: "brief-uuid-1" } }),
  );
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", anchor: true, env: ENV, transport });
  assert.deepEqual(res.anchor, { briefId: "brief-uuid-1" });
  assert.match(res.rendered, /now anchored to this brief/i);
});

test("saveBrief: a normal write that clears the anchor alongside content echoes anchor:null back", async () => {
  const transport = fakeTransport(() => successResponse({ anchor: null }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "crm", title: "Add a CRM", anchor: false, env: ENV, transport });
  assert.equal(res.anchor, null);
  assert.match(res.rendered, /anchor was cleared/i);
});

test("saveBrief: a normal write that never touched the anchor has NO anchor key on the result at all", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", env: ENV, transport });
  assert.equal("anchor" in res, false);
});

// ---------------------------------------------------------------------------
// saveBrief — request shape: no `status`, ever
// ---------------------------------------------------------------------------

test("saveBrief: the POST body NEVER carries a status field — there is no parameter for it", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", env: ENV, transport });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.equal("status" in sentBody, false);
});

test("saveBrief: omitted title/openQuestion/grounding/items are OMITTED from the body, not sent as null/undefined", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody, { eveSessionId: EVE_SESSION_ID, slug: "blog" });
});

test("saveBrief: items ride as a sanitized delta, and grounding is normalized defensively", async () => {
  const transport = fakeTransport(() => successResponse());
  await saveBrief({
    eveSessionId: EVE_SESSION_ID,
    slug: "blog",
    grounding: { wikiPageSlugs: ["wiki/overview"], commitSha: "129103aa" },
    items: [{ area: "problem", statement: "Needs auth.", kind: "required" }],
    env: ENV,
    transport,
  });
  const sentBody = JSON.parse(transport.calls[0].init.body);
  assert.deepEqual(sentBody.grounding, { wikiPageSlugs: ["wiki/overview"], memoryItemIds: [], commitSha: "129103aa" });
  assert.deepEqual(sentBody.items, [{ area: "problem", statement: "Needs auth.", kind: "required" }]);
});

test("saveBrief: sends the auth + content-type headers", async () => {
  let seenInit = null;
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return successResponse();
  });
  await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", env: ENV, transport });
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(seenInit.headers["Content-Type"], "application/json");
});

// ---------------------------------------------------------------------------
// saveBrief — transport / HTTP outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("saveBrief: transport throws -> degraded('unreachable'), exactly one attempt, no leaked error text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("saveBrief: 400 relays the console's own error message verbatim (e.g. status rejection, missing title)", async () => {
  const transport = fakeTransport(() => ({
    status: 400,
    json: async () => ({
      error:
        "status is not accepted on this route — it is a human-only label toggled in the console, never set by Jace.",
    }),
  }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.match(res.message, /status is not accepted on this route/);
});

test("saveBrief: 400 with no title and no existing brief relays that specific message", async () => {
  const transport = fakeTransport(() => ({
    status: 400,
    json: async () => ({ error: "title is required to create a new brief" }),
  }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(res.message, "title is required to create a new brief");
});

test("saveBrief: 401/403 -> degraded('unauthorized')", async () => {
  const transport = fakeTransport(() => ({ status: 401, json: async () => ({}) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "unauthorized");
});

test("saveBrief: 404 -> degraded('not_found')", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Session not found" }) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "not_found");
});

test("saveBrief: 422 (secret scan) -> degraded('content_rejected') with the console's message + reason detail, never the offending value", async () => {
  const transport = fakeTransport(() => ({
    status: 422,
    json: async () => ({
      error: "Brief content rejected: credential-shaped value detected",
      reason: "blocked 1 secret-shaped value(s): aws_access_key_id",
    }),
  }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "content_rejected");
  assert.equal(res.message, "Brief content rejected: credential-shaped value detected");
  assert.equal(res.detail, "blocked 1 secret-shaped value(s): aws_access_key_id");
  assert.match(res.note, /never retry/i);
});

test("saveBrief: 500 -> degraded('upstream_error')", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
});

test("saveBrief: non-JSON body on a non-2xx status still maps to the status's reason", async () => {
  const transport = fakeTransport(() => ({
    status: 500,
    json: async () => {
      throw new SyntaxError("nope");
    },
  }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
  assert.equal(res.status, 500);
});

test("saveBrief: non-JSON body on 200 -> degraded('bad_body'), unconfirmed not assumed-successful", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "bad_body");
  assert.match(res.note, /UNCONFIRMED/);
});

test("saveBrief: malformed 200 body (no brief) -> degraded('bad_body')", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ nope: true }) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("saveBrief: degraded results never leak the bearer token", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
});

// ---------------------------------------------------------------------------
// saveBrief — success, and the two refusal arrays are ALWAYS present
// ---------------------------------------------------------------------------

test("saveBrief: success returns brief/items and both refusal arrays present (even empty), plus a rendered summary", async () => {
  const transport = fakeTransport(() => successResponse());
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", title: "Add a blog", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.brief.slug, "blog");
  assert.equal(res.items.length, 1);
  assert.deepEqual(res.skippedHumanAuthorityIds, []);
  assert.deepEqual(res.skippedUnknownResolvedIds, []);
  assert.match(res.rendered, /Saved brief "blog" — 1 item\(s\) written\./);
});

test("saveBrief: success carries skippedHumanAuthorityIds/skippedUnknownResolvedIds through verbatim (as ids)", async () => {
  const transport = fakeTransport(() =>
    successResponse({ skippedHumanAuthorityIds: ["item-9"], skippedUnknownResolvedIds: ["item-7"] }),
  );
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.deepEqual(res.skippedHumanAuthorityIds, ["item-9"]);
  assert.deepEqual(res.skippedUnknownResolvedIds, ["item-7"]);
  assert.match(res.rendered, /REFUSED \(human-locked\)/);
  assert.match(res.rendered, /REFUSED \(unknown can't resolve\)/);
});

test("saveBrief: skippedUnknownResolvedIds may carry a brand-new item's statement (no id yet) — hardened defensively", async () => {
  const transport = fakeTransport(() =>
    successResponse({ skippedUnknownResolvedIds: ["see javascript:alert(1) ​here"] }),
  );
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.match(res.skippedUnknownResolvedIds[0], /javascript\[:\]alert\(1\)/);
});

test("saveBrief: success projects brief/items through the same hardening fetch_briefs applies on the read side", async () => {
  const transport = fakeTransport(() =>
    successResponse({
      brief: briefBody({ title: "click javascript:alert(1) ​now" }),
    }),
  );
  const res = await saveBrief({ eveSessionId: EVE_SESSION_ID, slug: "blog", env: ENV, transport });
  assert.match(res.brief.title, /javascript\[:\]alert\(1\)/);
});
