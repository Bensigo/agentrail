// Unit tests for the briefs fetch core (no SDK, no live network). The single
// HTTP call is an injected `transport` seam, so every branch — success, the
// honest "no brief yet", and each degraded outcome — is exercised
// deterministically. Mirrors fetch_repo_wiki.core.test.mjs's fakeTransport
// pattern.
//
// The fetch NEVER throws and NEVER retries. On an unconfigured, unreachable,
// or failing console the core returns a degraded result carrying a stable
// reason + a cause-free note (never a brief's content, never transport error
// text, never the bearer token).
//
// The workspace is still NEVER a param — it's derived server-side from the
// REQUIRED `eveSessionId` via the console's jace_sessions ledger, matching
// fetch_repo_wiki.core.mjs / fetch_workspace_memory.core.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEFS_PATH,
  MODES,
  UNTRUSTED_NOTICE,
  resolveConsoleConfig,
  buildBriefsUrl,
  classifyStatus,
  degraded,
  projectBriefItem,
  projectBriefItems,
  projectBrief,
  projectBriefWithItems,
  projectBriefs,
  renderList,
  renderBriefDetail,
  renderGet,
  renderSearch,
  fetchBriefs,
} from "../agent/lib/fetch_briefs.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};
const EVE_SESSION_ID = "eve-session-abc";

// A fake transport that records how many times it was called and with what,
// so we can assert single-attempt (no-retry) behaviour and header shape.
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
    area: "problem",
    statement: "Readers need a way to publish posts.",
    evidence: "we want a blog so customers can read updates",
    kind: "required",
    state: "open",
    resolution: null,
    authority: "jace",
    ...overrides,
  };
}

function brief(overrides = {}) {
  return {
    id: "brief-uuid-1",
    workspaceId: "ws-1",
    repositoryId: null,
    slug: "blog",
    title: "Add a blog",
    status: "draft",
    openQuestion: "Who can publish posts?",
    grounding: { wikiPageSlugs: ["wiki/overview"], memoryItemIds: [], commitSha: "129103aa" },
    jaceSessionIds: ["sess-1"],
    createdAt: "2026-07-27T14:57:00Z",
    updatedAt: "2026-07-27T15:10:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MODES / resolveConsoleConfig
// ---------------------------------------------------------------------------

test("MODES is exactly list/get/search", () => {
  assert.deepEqual(MODES, ["list", "get", "search"]);
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
// buildBriefsUrl
// ---------------------------------------------------------------------------

test("buildBriefsUrl always carries eveSessionId + mode", () => {
  const url = buildBriefsUrl("https://c.example.com", EVE_SESSION_ID, { mode: "list" });
  assert.equal(
    url,
    `https://c.example.com${BRIEFS_PATH}?eveSessionId=${encodeURIComponent(EVE_SESSION_ID)}&mode=list`,
  );
});

test("buildBriefsUrl carries slug only for mode=get", () => {
  const getUrl = buildBriefsUrl("https://c.example.com", EVE_SESSION_ID, { mode: "get", slug: "blog" });
  assert.match(getUrl, /[?&]slug=blog/);

  const listUrl = buildBriefsUrl("https://c.example.com", EVE_SESSION_ID, { mode: "list", slug: "blog" });
  assert.doesNotMatch(listUrl, /[?&]slug=/);
});

test("buildBriefsUrl carries query only for mode=search", () => {
  const searchUrl = buildBriefsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "search",
    query: "the blog thing",
  });
  assert.match(searchUrl, /[?&]query=the%20blog%20thing/);

  const listUrl = buildBriefsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "list",
    query: "the blog thing",
  });
  assert.doesNotMatch(listUrl, /[?&]query=/);
});

test("buildBriefsUrl NEVER carries a workspace param — the workspace is resolved server-side from eveSessionId", () => {
  const url = buildBriefsUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "search",
    query: "workspaceId=evil-tenant",
  });
  assert.doesNotMatch(url, /[?&]workspaceId=/);
});

// ---------------------------------------------------------------------------
// classifyStatus / degraded
// ---------------------------------------------------------------------------

test("classifyStatus maps HTTP status to outcome (2xx ok, rest degraded reasons)", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.deepEqual(classifyStatus(400), { ok: false, reason: "bad_request" });
  assert.deepEqual(classifyStatus(401), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(403), { ok: false, reason: "unauthorized" });
  assert.deepEqual(classifyStatus(404), { ok: false, reason: "not_found" });
  assert.deepEqual(classifyStatus(500), { ok: false, reason: "upstream_error" });
  assert.deepEqual(classifyStatus(418), { ok: false, reason: "unexpected_status" });
});

test("degraded carries a stable reason + cause-free note", () => {
  const d = degraded("unreachable");
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "unreachable");
  assert.ok(d.note.length > 0);
});

test("degraded('missing_slug' | 'missing_query') gives a corrective, not just a generic failure", () => {
  assert.match(degraded("missing_slug").note, /mode="get".*requires a slug/i);
  assert.match(degraded("missing_query").note, /mode="search".*requires a query/i);
});

test("degraded('not_found') frames a missing brief as expected, not a fetch failure", () => {
  assert.match(degraded("not_found").note, /brand-new idea/i);
});

// ---------------------------------------------------------------------------
// projectBriefItem / projectBriefItems — hardening + tolerant projection
// ---------------------------------------------------------------------------

test("projectBriefItem keeps the contract fields and coerces types defensively", () => {
  const p = projectBriefItem(item());
  assert.deepEqual(p, {
    id: "item-1",
    area: "problem",
    statement: "Readers need a way to publish posts.",
    evidence: "we want a blog so customers can read updates",
    kind: "required",
    state: "open",
    resolution: null,
    authority: "jace",
  });
});

test("projectBriefItem tolerates a missing/malformed raw item (never throws)", () => {
  assert.deepEqual(projectBriefItem(null), {
    id: "",
    area: "",
    statement: "",
    evidence: "",
    kind: "",
    state: "",
    resolution: null,
    authority: "",
  });
});

test("projectBriefItem runs statement/evidence through hardenUntrusted: strips invisibles, defangs dangerous schemes", () => {
  const p = projectBriefItem(
    item({
      statement: "see javascript:alert(1) ​here",
      evidence: "click javascript:alert(2) ​now",
    }),
  );
  assert.doesNotMatch(p.statement, /​/, "zero-width space stripped");
  assert.match(p.statement, /javascript\[:\]alert\(1\)/, "dangerous scheme defanged in statement");
  assert.match(p.evidence, /javascript\[:\]alert\(2\)/, "dangerous scheme defanged in evidence");
});

test("projectBriefItems projects every entry and tolerates a missing/non-array field", () => {
  assert.deepEqual(projectBriefItems(undefined), []);
  assert.deepEqual(projectBriefItems(null), []);
  const list = projectBriefItems([item({ id: "a" }), item({ id: "b" })]);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "a");
  assert.equal(list[1].id, "b");
});

// ---------------------------------------------------------------------------
// projectBrief / projectBriefWithItems / projectBriefs
// ---------------------------------------------------------------------------

test("projectBrief keeps slug/title/status/openQuestion/grounding/jaceSessionIds, drops the raw db id", () => {
  const p = projectBrief(brief());
  assert.equal(p.slug, "blog");
  assert.equal(p.title, "Add a blog");
  assert.equal(p.status, "draft");
  assert.equal(p.openQuestion, "Who can publish posts?");
  assert.deepEqual(p.grounding, {
    wikiPageSlugs: ["wiki/overview"],
    memoryItemIds: [],
    commitSha: "129103aa",
  });
  assert.deepEqual(p.jaceSessionIds, ["sess-1"]);
  assert.equal(p.createdAt, "2026-07-27T14:57:00Z");
  assert.equal(p.updatedAt, "2026-07-27T15:10:00Z");
  assert.equal(p.id, undefined, "the opaque db id is not carried into the projection");
  assert.equal(p.workspaceId, undefined);
});

test("projectBrief tolerates a missing/malformed raw brief (never throws)", () => {
  const p = projectBrief(null);
  assert.equal(p.slug, "");
  assert.equal(p.title, "");
  assert.deepEqual(p.grounding, { wikiPageSlugs: [], memoryItemIds: [], commitSha: null });
  assert.deepEqual(p.jaceSessionIds, []);
});

test("projectBrief hardens title/openQuestion and grounding id strings", () => {
  const p = projectBrief(
    brief({
      title: "click javascript:alert(1) ​now",
      openQuestion: "see javascript:alert(2) ​here",
      grounding: { wikiPageSlugs: ["javascript:alert(3)​"], memoryItemIds: [], commitSha: null },
    }),
  );
  assert.match(p.title, /javascript\[:\]alert\(1\)/);
  assert.match(p.openQuestion, /javascript\[:\]alert\(2\)/);
  assert.match(p.grounding.wikiPageSlugs[0], /javascript\[:\]alert\(3\)/);
});

test("projectBriefWithItems attaches items and derives openUnknownCount from open+unknown items only", () => {
  const raw = brief({
    items: [
      item({ id: "a", state: "open", kind: "unknown" }),
      item({ id: "b", state: "open", kind: "required" }),
      item({ id: "c", state: "resolved", kind: "unknown", resolution: "deferred" }),
      item({ id: "d", state: "open", kind: "unknown" }),
    ],
  });
  const p = projectBriefWithItems(raw);
  assert.equal(p.items.length, 4);
  assert.equal(p.openUnknownCount, 2, "only open+unknown items count — resolved unknowns don't block");
});

test("projectBriefWithItems tolerates a missing items array", () => {
  const p = projectBriefWithItems(brief());
  assert.deepEqual(p.items, []);
  assert.equal(p.openUnknownCount, 0);
});

test("projectBriefs projects a body's briefs array, tolerant of a missing/non-array field", () => {
  assert.deepEqual(projectBriefs({}), []);
  assert.deepEqual(projectBriefs(null), []);
  const list = projectBriefs({ briefs: [brief({ slug: "a" }), brief({ slug: "b" })] });
  assert.equal(list.length, 2);
  assert.equal(list[0].slug, "a");
  assert.equal(list[1].slug, "b");
});

// ---------------------------------------------------------------------------
// renderList / renderBriefDetail / renderGet / renderSearch
// ---------------------------------------------------------------------------

test("renderList carries the untrusted notice and names slug/title/status/openQuestion", () => {
  const briefs = projectBriefs({ briefs: [brief({ slug: "blog" }), brief({ slug: "crm", openQuestion: "" })] });
  const text = renderList({ briefs });
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /- blog — Add a blog \[draft\]/);
  assert.match(text, /open question: Who can publish posts\?/);

  const lines = text.split("\n");
  const crmIdx = lines.findIndex((l) => l.includes("- crm"));
  assert.ok(crmIdx >= 0);
  // The line right after "- crm" must be "last touched", never "open
  // question:" — crm's openQuestion is "" (nothing in flight).
  assert.match(lines[crmIdx + 1], /last touched/);
});

test("renderList handles no briefs honestly (no fabrication)", () => {
  const text = renderList({ briefs: [] });
  assert.match(text, /No briefs yet for this workspace\./);
});

test("renderBriefDetail renders title/status/openQuestion, every item, the open-unknown warning, and grounding", () => {
  const p = projectBriefWithItems(
    brief({
      items: [item({ id: "a", state: "open", kind: "unknown", statement: "Who approves posts?" })],
    }),
  );
  const text = renderBriefDetail(p);
  assert.match(text, /Add a blog \(blog\) — status: draft/);
  assert.match(text, /Open question: Who can publish posts\?/);
  assert.match(text, /- \[problem\] unknown\/open \(jace\) — Who approves posts\?/);
  assert.match(text, /evidence: "we want a blog so customers can read updates"/);
  assert.match(text, /1 item\(s\) are open and still kind="unknown"/);
  assert.match(text, /Grounding: 1 wiki page\(s\) cited, commit 129103aa\./);
});

test("renderBriefDetail says 'none recorded yet' when there are no items, and omits the open-unknown warning", () => {
  const p = projectBriefWithItems(brief());
  const text = renderBriefDetail(p);
  assert.match(text, /Items: none recorded yet\./);
  assert.doesNotMatch(text, /kind="unknown"/);
});

test("renderGet is honest when no brief matched the slug — an expected outcome, not an error", () => {
  const text = renderGet({ slug: "nonexistent", brief: undefined });
  assert.match(text, /No brief found at slug "nonexistent"\./);
});

test("renderGet renders full detail plus the untrusted notice when a brief is found", () => {
  const p = projectBriefWithItems(brief());
  const text = renderGet({ slug: "blog", brief: p });
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /Add a blog \(blog\)/);
});

test("renderSearch renders every hit's full detail, in order, or an honest 'nothing matched'", () => {
  const briefs = [
    projectBriefWithItems(brief({ slug: "blog", title: "Add a blog" })),
    projectBriefWithItems(brief({ slug: "crm", title: "Add a CRM" })),
  ];
  const text = renderSearch({ query: "add", briefs });
  assert.match(text, /for "add" — 2 hit\(s\)\./);
  assert.ok(text.indexOf("Add a blog") < text.indexOf("Add a CRM"));

  const empty = renderSearch({ query: "nope", briefs: [] });
  assert.match(empty, /No matching briefs\./);
});

// ---------------------------------------------------------------------------
// fetchBriefs — local validation guards (no wasted transport call)
// ---------------------------------------------------------------------------

test("fetchBriefs: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ briefs: [] }));
  for (const badId of [undefined, "", "   "]) {
    const res = await fetchBriefs({ eveSessionId: badId, mode: "list", env: ENV, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("fetchBriefs: invalid mode -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ briefs: [] }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "delete", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchBriefs: mode=get without slug -> degraded('missing_slug'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ briefs: [] }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "get", env: ENV, transport });
  assert.equal(res.reason, "missing_slug");
  assert.equal(transport.calls.length, 0);
});

test("fetchBriefs: mode=search without query -> degraded('missing_query'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ briefs: [] }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "search", env: ENV, transport });
  assert.equal(res.reason, "missing_query");
  assert.equal(transport.calls.length, 0);
});

test("fetchBriefs: unset console config -> degraded('config_missing') with missing vars, transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ briefs: [] }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: {}, transport });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// fetchBriefs — transport / HTTP outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("fetchBriefs: transport throws -> degraded('unreachable'), exactly one attempt, no leaked error text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("fetchBriefs: mode=get 404 -> honest 'no brief yet', NOT a degraded failure", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Brief blog not found" }) }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "get", slug: "blog", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.degraded, undefined);
  assert.equal(res.brief, undefined);
  assert.match(res.rendered, /No brief found at slug "blog"\./);
});

test("fetchBriefs: mode=list 404 (session not found) -> degraded('not_found')", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({ error: "Session not found" }) }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "not_found");
});

test("fetchBriefs: degraded results never leak the bearer token", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
});

test("fetchBriefs: non-JSON body on 200 -> degraded('bad_body')", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("fetchBriefs: non-JSON body on a non-2xx status still maps to the status's reason, not bad_body", async () => {
  const transport = fakeTransport(() => ({
    status: 500,
    json: async () => {
      throw new SyntaxError("nope");
    },
  }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// fetchBriefs — success, per mode
// ---------------------------------------------------------------------------

test("fetchBriefs: mode=list success renders the index and sends the auth header", async () => {
  let seenInit = null;
  const body = { schemaVersion: 1, mode: "list", briefs: [brief({ slug: "blog" }), brief({ slug: "crm" })] };
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return okResponse(body);
  });
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "list");
  assert.equal(res.briefs.length, 2);
  assert.match(res.rendered, /- blog — Add a blog \[draft\]/);
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls.length, 1);
});

test("fetchBriefs: mode=get success renders the full brief and passes slug through the URL", async () => {
  const body = { schemaVersion: 1, mode: "get", brief: brief({ items: [item()] }) };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "get", slug: "blog", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.brief.slug, "blog");
  assert.equal(res.brief.items.length, 1);
  assert.match(res.rendered, /Add a blog \(blog\)/);
  assert.match(transport.calls[0].url, /slug=blog/);
});

test("fetchBriefs: mode=search success renders every hit and passes query through the URL", async () => {
  const body = {
    schemaVersion: 1,
    mode: "search",
    briefs: [brief({ slug: "blog", title: "Add a blog", items: [item()] })],
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchBriefs({
    eveSessionId: EVE_SESSION_ID,
    mode: "search",
    query: "the blog thing",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.match(res.rendered, /Add a blog/);
  assert.match(transport.calls[0].url, /query=the%20blog%20thing/);
});

test("fetchBriefs: malformed success body (no briefs array) -> empty briefs, not a throw", async () => {
  const transport = fakeTransport(() => okResponse({ nope: true }));
  const res = await fetchBriefs({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.deepEqual(res.briefs, []);
});
