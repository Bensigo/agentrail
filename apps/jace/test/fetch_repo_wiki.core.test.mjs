// Unit tests for the repo-wiki fetch core (no SDK, no live network). The
// single HTTP call is an injected `transport` seam, so every branch —
// success, repo_required, and each degraded outcome — is exercised
// deterministically.
//
// The fetch NEVER throws and NEVER retries. On an unconfigured, unreachable,
// not-yet-deployed, or failing console the core returns a degraded result
// carrying a stable reason + a cause-free note (never the wiki's content,
// never transport error text, never the bearer token).
//
// The workspace is still NEVER a param — it's derived server-side from the
// REQUIRED `eveSessionId` via the console's jace_sessions ledger, matching
// fetch_workspace_memory.core.mjs / fetch_backlog.core.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WIKI_PATH,
  MODES,
  UNTRUSTED_NOTICE,
  resolveConsoleConfig,
  normalizeLimit,
  buildWikiUrl,
  classifyStatus,
  degraded,
  provenanceLine,
  staleLabel,
  projectPage,
  projectPages,
  renderList,
  renderGet,
  renderSearch,
  renderRepoRequired,
  fetchRepoWiki,
} from "../agent/lib/fetch_repo_wiki.core.mjs";

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

function page(overrides = {}) {
  return {
    slug: "wiki/unit/agentrail-context",
    title: "agentrail/context — Context Compiler",
    kind: "unit",
    stale: false,
    commitSha: "129103aa",
    generatedAt: "2026-07-23T14:00:00Z",
    model: "claude-haiku-4-5-20251001",
    bodyMd: "## Responsibility\nCompiles the context.",
    citations: ["agentrail/context/index.py"],
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
// normalizeLimit
// ---------------------------------------------------------------------------

test("normalizeLimit clamps to the contract's 1..10 bound and omits blank/invalid input", () => {
  assert.equal(normalizeLimit(undefined), undefined);
  assert.equal(normalizeLimit(null), undefined);
  assert.equal(normalizeLimit(""), undefined);
  assert.equal(normalizeLimit(0), undefined);
  assert.equal(normalizeLimit(-3), undefined);
  assert.equal(normalizeLimit("nope"), undefined);
  assert.equal(normalizeLimit(3), 3);
  assert.equal(normalizeLimit(10), 10);
  assert.equal(normalizeLimit(11), 10); // clamped to max
  assert.equal(normalizeLimit(2.9), 2); // truncated, not rounded
});

// ---------------------------------------------------------------------------
// buildWikiUrl
// ---------------------------------------------------------------------------

test("buildWikiUrl always carries eveSessionId + mode", () => {
  const url = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, { mode: "list" });
  assert.equal(
    url,
    `https://c.example.com${WIKI_PATH}?eveSessionId=${encodeURIComponent(EVE_SESSION_ID)}&mode=list`,
  );
});

test("buildWikiUrl carries repo when set, regardless of mode", () => {
  const url = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "list",
    repo: "owner/name",
  });
  assert.match(url, /[?&]repo=owner%2Fname/);
});

test("buildWikiUrl carries slug only for mode=get", () => {
  const getUrl = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "get",
    slug: "wiki/overview",
  });
  assert.match(getUrl, /[?&]slug=wiki%2Foverview/);

  const listUrl = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "list",
    slug: "wiki/overview",
  });
  assert.doesNotMatch(listUrl, /[?&]slug=/);
});

test("buildWikiUrl carries query + limit only for mode=search, limit clamped", () => {
  const searchUrl = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "search",
    query: "retry logic",
    limit: 25,
  });
  assert.match(searchUrl, /[?&]query=retry%20logic/);
  assert.match(searchUrl, /[?&]limit=10/); // clamped to max

  const listUrl = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, {
    mode: "list",
    query: "retry logic",
    limit: 3,
  });
  assert.doesNotMatch(listUrl, /[?&]query=/);
  assert.doesNotMatch(listUrl, /[?&]limit=/);
});

test("buildWikiUrl NEVER carries a workspace param — the workspace is resolved server-side from eveSessionId", () => {
  const url = buildWikiUrl("https://c.example.com", EVE_SESSION_ID, {
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
  assert.equal(typeof d.note, "string");
  assert.ok(d.note.length > 0);
});

test("degraded('unreachable') and degraded('not_found') both frame the gap as 'not available yet' (PR 4 may not have shipped)", () => {
  assert.match(degraded("unreachable").note, /repo wiki service is not available yet/i);
  assert.match(degraded("not_found").note, /repo wiki service is not available yet/i);
});

test("degraded('missing_slug' | 'missing_query') gives a corrective, not just a generic failure", () => {
  assert.match(degraded("missing_slug").note, /mode="get".*requires a slug/i);
  assert.match(degraded("missing_query").note, /mode="search".*requires a query/i);
});

// ---------------------------------------------------------------------------
// provenanceLine / staleLabel
// ---------------------------------------------------------------------------

test("provenanceLine renders 'compiled from <sha> at <date> — may lag the repo'", () => {
  assert.equal(
    provenanceLine({ commitSha: "129103aa", generatedAt: "2026-07-23T14:00:00Z" }),
    "compiled from 129103aa at 2026-07-23T14:00:00Z — may lag the repo",
  );
});

test("provenanceLine tolerates missing fields", () => {
  assert.equal(provenanceLine({}), "compiled from unknown commit at unknown time — may lag the repo");
});

test("staleLabel prefixes the exact stale marker only when stale:true", () => {
  assert.equal(
    staleLabel({ stale: true }),
    "[stale — code has changed since this was compiled] ",
  );
  assert.equal(staleLabel({ stale: false }), "");
  assert.equal(staleLabel({}), "");
});

// ---------------------------------------------------------------------------
// projectPage / projectPages — hardening + tolerant projection
// ---------------------------------------------------------------------------

test("projectPage keeps the contract fields and coerces types defensively", () => {
  const p = projectPage(page(), "get");
  assert.deepEqual(p, {
    slug: "wiki/unit/agentrail-context",
    title: "agentrail/context — Context Compiler",
    kind: "unit",
    stale: false,
    commitSha: "129103aa",
    generatedAt: "2026-07-23T14:00:00Z",
    model: "claude-haiku-4-5-20251001",
    bodyMd: "## Responsibility\nCompiles the context.",
    citations: ["agentrail/context/index.py"],
  });
});

test("projectPage tolerates a missing/malformed raw page (never throws)", () => {
  assert.deepEqual(projectPage(null, "list"), {
    slug: "",
    title: "",
    kind: "",
    stale: false,
    commitSha: "",
    generatedAt: "",
    model: "",
    bodyMd: "",
    citations: [],
  });
  assert.deepEqual(projectPage(undefined, "list").citations, []);
});

test("projectPage runs title/bodyMd/citations through hardenUntrusted: strips invisibles, defangs dangerous schemes", () => {
  const p = projectPage(
    page({
      title: "click javascript:alert(1) ​now",
      bodyMd: "see javascript:alert(2) ​here",
      citations: ["javascript:alert(3)​"],
    }),
    "get",
  );
  assert.doesNotMatch(p.title, /​/, "zero-width space stripped from title");
  assert.match(p.title, /javascript\[:\]alert\(1\)/, "dangerous scheme defanged in title");
  assert.match(p.bodyMd, /javascript\[:\]alert\(2\)/, "dangerous scheme defanged in bodyMd");
  assert.match(p.citations[0], /javascript\[:\]alert\(3\)/, "dangerous scheme defanged in citation");
});

test("projectPage caps bodyMd length differently for get (full) vs search (trimmed) mode", () => {
  const longBody = "a".repeat(9000);
  const getPage = projectPage(page({ bodyMd: longBody }), "get");
  const searchPage = projectPage(page({ bodyMd: longBody }), "search");
  assert.ok(getPage.bodyMd.length <= 8001, "get mode caps at 8000 chars + ellipsis");
  assert.ok(searchPage.bodyMd.length <= 2501, "search mode caps at 2500 chars + ellipsis");
  assert.ok(searchPage.bodyMd.length < getPage.bodyMd.length);
});

test("projectPage caps citation count defensively", () => {
  const many = Array.from({ length: 80 }, (_, i) => `file${i}.ts`);
  const p = projectPage(page({ citations: many }), "get");
  assert.equal(p.citations.length, 50);
});

test("projectPages projects every entry and tolerates a missing/non-array pages field", () => {
  assert.deepEqual(projectPages({}, "list"), []);
  assert.deepEqual(projectPages({ pages: null }, "list"), []);
  assert.deepEqual(projectPages(null, "list"), []);
  const list = projectPages({ pages: [page({ slug: "a" }), page({ slug: "b" })] }, "list");
  assert.equal(list.length, 2);
  assert.equal(list[0].slug, "a");
  assert.equal(list[1].slug, "b");
});

// ---------------------------------------------------------------------------
// renderList / renderGet / renderSearch / renderRepoRequired
// ---------------------------------------------------------------------------

test("renderList puts the overview first, then units with slug/title/staleness + provenance, and carries the untrusted notice", () => {
  const pages = [
    page({ slug: "wiki/overview", kind: "overview", title: "AgentRail overview" }),
    page({ slug: "wiki/unit/a", kind: "unit", title: "Unit A", stale: true }),
    page({ slug: "wiki/unit/b", kind: "unit", title: "Unit B", stale: false }),
  ];
  const text = renderList({ repo: "o/r", pages });
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const overviewIdx = text.indexOf("wiki/overview");
  const unitAIdx = text.indexOf("wiki/unit/a");
  const unitBIdx = text.indexOf("wiki/unit/b");
  assert.ok(overviewIdx >= 0 && overviewIdx < unitAIdx, "overview renders before units");
  assert.ok(unitAIdx < unitBIdx, "units render in order");
  assert.match(text, /\[stale — code has changed since this was compiled\] Unit A/);
  const unitBLine = text.split("\n").find((l) => l.includes("Unit B"));
  assert.ok(unitBLine && !unitBLine.includes("[stale"), "Unit B (stale:false) must not be marked stale");
  assert.match(text, /compiled from 129103aa at 2026-07-23T14:00:00Z — may lag the repo/);
});

test("renderList handles no compiled pages honestly (no fabrication)", () => {
  const text = renderList({ repo: "o/r", pages: [] });
  assert.match(text, /Overview: none compiled yet\./);
  assert.match(text, /Units: none compiled yet\./);
});

test("renderGet renders the full bodyMd with provenance, stale marker, and citations", () => {
  const text = renderGet({ repo: "o/r", page: page({ stale: true }) });
  assert.match(text, /\[stale — code has changed since this was compiled\]/);
  assert.match(text, /compiled from 129103aa at 2026-07-23T14:00:00Z — may lag the repo/);
  assert.match(text, /## Responsibility\nCompiles the context\./);
  assert.match(text, /Citations: agentrail\/context\/index\.py/);
  assert.match(text, new RegExp(UNTRUSTED_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("renderGet is honest when no page matched the slug", () => {
  const text = renderGet({ repo: "o/r", page: undefined });
  assert.match(text, /No wiki page found for o\/r at that slug\./);
});

test("renderSearch renders title + trimmed body per hit with provenance, in order", () => {
  const pages = [
    page({ slug: "a", title: "Hit A", bodyMd: "body a" }),
    page({ slug: "b", title: "Hit B", bodyMd: "body b", stale: true }),
  ];
  const text = renderSearch({ repo: "o/r", query: "retry", pages });
  assert.match(text, /for "retry" — 2 hit\(s\)\./);
  assert.ok(text.indexOf("Hit A") < text.indexOf("Hit B"));
  assert.match(text, /\[stale — code has changed since this was compiled\] Hit B/);
  assert.match(text, /body a/);
  assert.match(text, /body b/);
});

test("renderSearch is honest when nothing matched", () => {
  const text = renderSearch({ repo: "o/r", query: "nope", pages: [] });
  assert.match(text, /No matching wiki pages\./);
});

test("renderRepoRequired names the repos and how to re-call", () => {
  const text = renderRepoRequired(["o/repo-a", "o/repo-b"]);
  assert.match(text, /o\/repo-a/);
  assert.match(text, /o\/repo-b/);
  assert.match(text, /repo set to the exact full name/);
});

// ---------------------------------------------------------------------------
// fetchRepoWiki — local validation guards (no wasted transport call)
// ---------------------------------------------------------------------------

test("fetchRepoWiki: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ pages: [] }));
  for (const badId of [undefined, "", "   "]) {
    const res = await fetchRepoWiki({ eveSessionId: badId, mode: "list", env: ENV, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "bad_request");
  }
  assert.equal(transport.calls.length, 0);
});

test("fetchRepoWiki: invalid mode -> degraded('bad_request'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ pages: [] }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "delete", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(transport.calls.length, 0);
});

test("fetchRepoWiki: mode=get without slug -> degraded('missing_slug'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ pages: [] }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "get", env: ENV, transport });
  assert.equal(res.reason, "missing_slug");
  assert.equal(transport.calls.length, 0);
});

test("fetchRepoWiki: mode=search without query -> degraded('missing_query'), transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ pages: [] }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "search", env: ENV, transport });
  assert.equal(res.reason, "missing_query");
  assert.equal(transport.calls.length, 0);
});

test("fetchRepoWiki: unset console config -> degraded('config_missing') with missing vars, transport never called", async () => {
  const transport = fakeTransport(() => okResponse({ pages: [] }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: {}, transport });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// fetchRepoWiki — transport / HTTP outcomes, never throws, never retries
// ---------------------------------------------------------------------------

test("fetchRepoWiki: transport throws -> degraded('unreachable'), exactly one attempt, no leaked error text", async () => {
  const transport = fakeTransport(() => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
  });
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.degraded, true);
  assert.equal(res.reason, "unreachable");
  assert.equal(transport.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
});

test("fetchRepoWiki: 404 (route not deployed yet) -> degraded('not_found'), 'not available yet' framing", async () => {
  const transport = fakeTransport(() => ({ status: 404, json: async () => ({}) }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "not_found");
  assert.match(res.note, /repo wiki service is not available yet/i);
});

test("fetchRepoWiki: degraded results never leak the bearer token", async () => {
  const transport = fakeTransport(() => ({ status: 500, json: async () => ({}) }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
});

test("fetchRepoWiki: non-JSON body on 200 -> degraded('bad_body')", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "bad_body");
});

test("fetchRepoWiki: non-JSON body on a non-2xx status still maps to the status's reason, not bad_body", async () => {
  const transport = fakeTransport(() => ({
    status: 500,
    json: async () => {
      throw new SyntaxError("nope");
    },
  }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "upstream_error");
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------------------
// fetchRepoWiki — repo_required (multi-repo workspace, repo omitted)
// ---------------------------------------------------------------------------

test("fetchRepoWiki: 400 repo_required -> { repoRequired:true, repos, rendered } naming the repos, NOT a degraded failure", async () => {
  const transport = fakeTransport(() => ({
    status: 400,
    json: async () => ({ error: "repo_required", repos: ["o/repo-a", "o/repo-b"] }),
  }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, false);
  assert.equal(res.repoRequired, true);
  assert.equal(res.degraded, undefined, "repo_required is an actionable outcome, not a degraded failure");
  assert.deepEqual(res.repos, ["o/repo-a", "o/repo-b"]);
  assert.match(res.rendered, /o\/repo-a/);
  assert.match(res.rendered, /o\/repo-b/);
});

test("fetchRepoWiki: a plain 400 (not repo_required) -> degraded('bad_request')", async () => {
  const transport = fakeTransport(() => ({
    status: 400,
    json: async () => ({ error: "invalid_mode" }),
  }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.reason, "bad_request");
  assert.equal(res.repoRequired, undefined);
});

// ---------------------------------------------------------------------------
// fetchRepoWiki — success, per mode
// ---------------------------------------------------------------------------

test("fetchRepoWiki: mode=list success renders overview + units and sends the auth header", async () => {
  let seenInit = null;
  const body = {
    schemaVersion: 1,
    repo: "o/r",
    mode: "list",
    pages: [
      page({ slug: "wiki/overview", kind: "overview", title: "Overview" }),
      page({ slug: "wiki/unit/a", kind: "unit", title: "Unit A" }),
    ],
  };
  const transport = fakeTransport((_url, init) => {
    seenInit = init;
    return okResponse(body);
  });
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "list");
  assert.equal(res.repo, "o/r");
  assert.equal(res.pages.length, 2);
  assert.match(res.rendered, /Overview: Overview \(slug: wiki\/overview\)/);
  assert.match(res.rendered, /- wiki\/unit\/a — Unit A/);
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
  assert.equal(transport.calls.length, 1);
});

test("fetchRepoWiki: mode=get success renders the full page and passes slug through the URL", async () => {
  const body = { schemaVersion: 1, repo: "o/r", mode: "get", pages: [page()] };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchRepoWiki({
    eveSessionId: EVE_SESSION_ID,
    mode: "get",
    slug: "wiki/unit/agentrail-context",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.match(res.rendered, /## Responsibility\nCompiles the context\./);
  assert.match(res.rendered, /Citations: agentrail\/context\/index\.py/);
  assert.match(transport.calls[0].url, /slug=wiki%2Funit%2Fagentrail-context/);
});

test("fetchRepoWiki: mode=search success renders hits and passes query through the URL", async () => {
  const body = {
    schemaVersion: 1,
    repo: "o/r",
    mode: "search",
    pages: [page({ slug: "wiki/unit/a", title: "Hit A" })],
  };
  const transport = fakeTransport(() => okResponse(body));
  const res = await fetchRepoWiki({
    eveSessionId: EVE_SESSION_ID,
    mode: "search",
    query: "retry logic",
    env: ENV,
    transport,
  });
  assert.equal(res.ok, true);
  assert.match(res.rendered, /Hit A/);
  assert.match(transport.calls[0].url, /query=retry%20logic/);
});

test("fetchRepoWiki: falls back to the requested repo when the body omits one (malformed-response defense)", async () => {
  const transport = fakeTransport(() => okResponse({ pages: [] }));
  const res = await fetchRepoWiki({
    eveSessionId: EVE_SESSION_ID,
    mode: "list",
    repo: "o/r",
    env: ENV,
    transport,
  });
  assert.equal(res.repo, "o/r");
});

test("fetchRepoWiki: malformed success body (no pages array) -> empty pages, not a throw", async () => {
  const transport = fakeTransport(() => okResponse({ nope: true }));
  const res = await fetchRepoWiki({ eveSessionId: EVE_SESSION_ID, mode: "list", env: ENV, transport });
  assert.equal(res.ok, true);
  assert.deepEqual(res.pages, []);
});
