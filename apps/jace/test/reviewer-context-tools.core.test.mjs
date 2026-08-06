// Unit tests for the reviewer subagent's FOUR context-tool cores
// (read_repo_file, search_code, file_history, fetch_wiki) — no SDK, no live
// network. Each core is pure and dependency-free, transcribing
// fetch_pr_diff.core.mjs's own structure (injected `transport` seam,
// duplicated resolveConsoleConfig/classifyStatus/degraded, single-attempt
// fetch fn, never throws) with its own PATH/params/success shape. ONE suite
// covers all four via a `for (const c of CASES)` table — they share the
// pattern closely enough that four separate files would quadruple
// boilerplate for the same assertions. Mirrors the fakeTransport pattern
// from fetch_pr_diff.core.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as ReadRepoFile from "../legacy/reviewer/lib/read_repo_file.core.mjs";
import * as SearchCode from "../legacy/reviewer/lib/search_code.core.mjs";
import * as FileHistory from "../legacy/reviewer/lib/file_history.core.mjs";
import * as FetchWiki from "../legacy/reviewer/lib/fetch_wiki.core.mjs";

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

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

// ---------------------------------------------------------------------------
// The CASES table — one entry per core, carrying everything the shared loop
// needs plus small per-core hooks for the parts that differ (URL shape,
// success body/shape, coercion defaults, the not_found note's honest
// possibilities, the route-specific degraded-note phrase).
// ---------------------------------------------------------------------------

const PHRASES = {
  read_repo_file: "no file could be fetched",
  search_code: "no search could be run",
  file_history: "no history could be fetched",
  fetch_wiki: "the repo wiki is not available",
};

const CASES = [
  {
    name: "read_repo_file",
    fn: ReadRepoFile.readRepoFile,
    path: ReadRepoFile.REPO_FILE_PATH,
    resolveConfigFn: ReadRepoFile.resolveConsoleConfig,
    classifyStatusFn: ReadRepoFile.classifyStatus,
    degradedFn: ReadRepoFile.degraded,
    validArgs: { eveSessionId: "eve-1", repo: "ada/widgets", path: "src/index.ts" },
    requiredFields: ["eveSessionId", "repo", "path"],
    expectedUrl: (base) =>
      `${base}${ReadRepoFile.REPO_FILE_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&path=src%2Findex.ts`,
    successBody: { path: "src/index.ts", ref: "", kind: "file", content: "hello world", size: 11, truncated: false },
    assertSuccess: (res) => {
      assert.equal(res.kind, "file");
      assert.equal(res.content, "hello world");
      assert.equal(res.size, 11);
      assert.equal(res.truncated, false);
      assert.equal(res.path, "src/index.ts");
      assert.equal(res.ref, "");
      assert.deepEqual(res.entries, []);
    },
    assertEmptyBodyDefaults: (res) => {
      assert.equal(res.kind, "");
      assert.equal(res.content, "");
      assert.deepEqual(res.entries, []);
      assert.equal(res.size, 0);
      assert.equal(res.truncated, false);
      assert.equal(res.path, "");
      assert.equal(res.ref, "");
    },
    notFoundNoteChecks: [/path/i, /repo is not connected/i],
    // repo-file's classifyGithubError reclassifies GitHub's own 401/403 into
    // EITHER 409 (stale/revoked GitHub App install) or 429 (rate limit) — it
    // never passes a raw 401/403 through. So this core's conflict (409) note
    // must name that reclassified possibility alongside "not set up yet".
    conflictNoteChecks: [/isn't fully set up/i, /stale\/revoked/i],
  },
  {
    name: "search_code",
    fn: SearchCode.searchCode,
    path: SearchCode.CODE_SEARCH_PATH,
    resolveConfigFn: SearchCode.resolveConsoleConfig,
    classifyStatusFn: SearchCode.classifyStatus,
    degradedFn: SearchCode.degraded,
    validArgs: { eveSessionId: "eve-1", repo: "ada/widgets", query: "resolveWorkspaceRepoToken" },
    requiredFields: ["eveSessionId", "repo", "query"],
    expectedUrl: (base) =>
      `${base}${SearchCode.CODE_SEARCH_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&q=resolveWorkspaceRepoToken`,
    successBody: {
      totalCount: 3,
      note: "textual matches, not a compiled call graph",
      results: [{ path: "a.ts", fragments: ["<em>resolveWorkspaceRepoToken</em>"] }],
    },
    assertSuccess: (res) => {
      assert.equal(res.totalCount, 3);
      assert.equal(res.note, "textual matches, not a compiled call graph");
      assert.deepEqual(res.results, [{ path: "a.ts", fragments: ["<em>resolveWorkspaceRepoToken</em>"] }]);
    },
    assertEmptyBodyDefaults: (res) => {
      assert.equal(res.totalCount, 0);
      assert.equal(res.note, "");
      assert.deepEqual(res.results, []);
    },
    notFoundNoteChecks: [/repo is not connected/i],
    // Same reclassification as repo-file (shared resolveWorkspaceRepoToken +
    // classifyGithubError shape) — see that case's own comment.
    conflictNoteChecks: [/isn't fully set up/i, /stale\/revoked/i],
  },
  {
    name: "file_history",
    fn: FileHistory.fileHistory,
    path: FileHistory.FILE_HISTORY_PATH,
    resolveConfigFn: FileHistory.resolveConsoleConfig,
    classifyStatusFn: FileHistory.classifyStatus,
    degradedFn: FileHistory.degraded,
    validArgs: { eveSessionId: "eve-1", repo: "ada/widgets", path: "src/index.ts" },
    requiredFields: ["eveSessionId", "repo", "path"],
    expectedUrl: (base) =>
      `${base}${FileHistory.FILE_HISTORY_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&path=src%2Findex.ts`,
    successBody: {
      path: "src/index.ts",
      commits: [{ sha: "abc123", shortSha: "abc123", authorLogin: "ada", date: "2026-01-01T00:00:00Z", messageFirstLine: "fix widgets" }],
    },
    assertSuccess: (res) => {
      assert.equal(res.path, "src/index.ts");
      assert.deepEqual(res.commits, [
        { sha: "abc123", shortSha: "abc123", authorLogin: "ada", date: "2026-01-01T00:00:00Z", messageFirstLine: "fix widgets" },
      ]);
    },
    assertEmptyBodyDefaults: (res) => {
      assert.equal(res.path, "");
      assert.deepEqual(res.commits, []);
    },
    notFoundNoteChecks: [/path|history/i, /repo is not connected/i],
    // Same reclassification as repo-file/code-search (shared
    // resolveWorkspaceRepoToken + classifyGithubError shape).
    conflictNoteChecks: [/isn't fully set up/i, /stale\/revoked/i],
  },
  {
    name: "fetch_wiki",
    fn: FetchWiki.fetchWiki,
    path: FetchWiki.REPO_WIKI_PATH,
    resolveConfigFn: FetchWiki.resolveConsoleConfig,
    classifyStatusFn: FetchWiki.classifyStatus,
    degradedFn: FetchWiki.degraded,
    validArgs: { eveSessionId: "eve-1", repo: "ada/widgets" }, // neither slug nor query -> mode=list
    requiredFields: ["eveSessionId", "repo"],
    expectedUrl: (base) =>
      `${base}${FetchWiki.REPO_WIKI_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&mode=list`,
    successBody: { schemaVersion: 1, repo: "ada/widgets", mode: "list", pages: [{ slug: "overview", title: "Overview" }] },
    assertSuccess: (res) => {
      assert.equal(res.mode, "list");
      assert.equal(res.repo, "ada/widgets");
      assert.deepEqual(res.pages, [{ slug: "overview", title: "Overview" }]);
    },
    assertEmptyBodyDefaults: (res) => {
      assert.equal(res.mode, "");
      assert.equal(res.repo, "");
      assert.deepEqual(res.pages, []);
    },
    notFoundNoteChecks: [/slug/i, /repo is not connected/i],
    // UNLIKE its three siblings above: repo-wiki never itself calls GitHub
    // (a pure Postgres read), so it has no reclassified-401/403 conflict
    // case — its 409 is honestly JUST "workspace not fully set up".
    conflictNoteChecks: [/not fully set up/i],
  },
];

// ---------------------------------------------------------------------------
// resolveConsoleConfig — each core duplicates its own copy verbatim (house
// convention); prove each copy actually works, not just one of them.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: resolveConsoleConfig resolves + trims + de-slashes when both vars are set`, () => {
    const cfg = c.resolveConfigFn({
      JACE_CONSOLE_BASE_URL: "  https://c.example.com/  ",
      JACE_CONSOLE_TOKEN: "  tok  ",
    });
    assert.deepEqual(cfg, { ok: true, baseUrl: "https://c.example.com", token: "tok" });
  });

  test(`${c.name}: resolveConsoleConfig reports exactly which vars are missing`, () => {
    assert.deepEqual(c.resolveConfigFn({}), {
      ok: false,
      missing: ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"],
    });
    assert.deepEqual(c.resolveConfigFn({ JACE_CONSOLE_BASE_URL: "https://c" }), {
      ok: false,
      missing: ["JACE_CONSOLE_TOKEN"],
    });
  });
}

// ---------------------------------------------------------------------------
// classifyStatus — the same table, duplicated verbatim per core.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: classifyStatus maps the full HTTP status table`, () => {
    assert.deepEqual(c.classifyStatusFn(200), { ok: true });
    assert.deepEqual(c.classifyStatusFn(204), { ok: true });
    assert.deepEqual(c.classifyStatusFn(400), { ok: false, reason: "bad_request" });
    assert.deepEqual(c.classifyStatusFn(401), { ok: false, reason: "unauthorized" });
    assert.deepEqual(c.classifyStatusFn(403), { ok: false, reason: "unauthorized" });
    assert.deepEqual(c.classifyStatusFn(404), { ok: false, reason: "not_found" });
    assert.deepEqual(c.classifyStatusFn(409), { ok: false, reason: "conflict" });
    assert.deepEqual(c.classifyStatusFn(429), { ok: false, reason: "rate_limited" });
    assert.deepEqual(c.classifyStatusFn(500), { ok: false, reason: "upstream_error" });
    assert.deepEqual(c.classifyStatusFn(418), { ok: false, reason: "unexpected_status" });
  });
}

// ---------------------------------------------------------------------------
// degraded() — stable reason + cause-free, non-empty note; route-specific
// rewording of fetch_pr_diff's phrase; not_found names honest possibilities.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: degraded() carries a stable reason + cause-free non-empty note`, () => {
    const d = c.degradedFn("unreachable", { status: 0 });
    assert.equal(d.ok, false);
    assert.equal(d.degraded, true);
    assert.equal(d.reason, "unreachable");
    assert.equal(typeof d.note, "string");
    assert.ok(d.note.length > 0);
    assert.equal(d.status, 0);
    assert.equal(typeof c.degradedFn("who_knows").note, "string");
  });

  test(`${c.name}: degraded notes reword fetch_pr_diff's phrase for this route ("${PHRASES[c.name]}")`, () => {
    for (const reason of ["config_missing", "bad_request", "unreachable", "rate_limited", "upstream_error"]) {
      const d = c.degradedFn(reason);
      assert.ok(
        d.note.includes(PHRASES[c.name]),
        `${c.name} degraded(${reason}).note should include "${PHRASES[c.name]}", got: ${d.note}`,
      );
    }
  });

  test(`${c.name}: not_found note names the honest possibilities`, () => {
    const d = c.degradedFn("not_found");
    for (const re of c.notFoundNoteChecks) {
      assert.match(d.note, re, `${c.name} not_found note should match ${re}, got: ${d.note}`);
    }
  });

  // Regression pin: none of these routes' classifyGithubError ever passes a
  // raw GitHub 401/403 through — GitHub's own 401/403 is always reclassified
  // to 409 (stale/revoked install) or 429 (rate limit) before it reaches
  // Jace. The ONLY 401/403 a core can actually see is requireJaceConsoleSecret
  // rejecting the shared JACE_CONSOLE_TOKEN (a deployment config problem, not
  // a workspace one) — so the unauthorized note must name THAT cause, never
  // "GitHub credentials".
  test(`${c.name}: unauthorized note names the shared console token, never GitHub credentials`, () => {
    const d = c.degradedFn("unauthorized");
    assert.match(
      d.note,
      /JACE_CONSOLE_TOKEN/,
      `${c.name} unauthorized note should name the shared JACE_CONSOLE_TOKEN, got: ${d.note}`,
    );
    assert.doesNotMatch(
      d.note,
      /GitHub credentials/i,
      `${c.name} unauthorized note must not blame GitHub credentials — a raw 401/403 from GitHub never ` +
        `reaches this core (it's reclassified to 409/429 first), so only the shared console token can be the ` +
        `cause here, got: ${d.note}`,
    );
  });

  test(`${c.name}: conflict note names this route's own honest 409 possibilities`, () => {
    const d = c.degradedFn("conflict");
    for (const re of c.conflictNoteChecks) {
      assert.match(d.note, re, `${c.name} conflict note should match ${re}, got: ${d.note}`);
    }
  });
}

// ---------------------------------------------------------------------------
// URL building — params encoded, exact expected URL per core.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: builds the expected URL with eveSessionId/repo + this core's own params, encoded`, async () => {
    const transport = fakeTransport(() => ({ status: 200, json: async () => c.successBody }));
    await c.fn({ env: ENV, ...c.validArgs, transport });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].url, c.expectedUrl(ENV.JACE_CONSOLE_BASE_URL));
    assert.equal(transport.calls[0].init.headers.Authorization, `Bearer ${ENV.JACE_CONSOLE_TOKEN}`);
    assert.equal(transport.calls[0].init.headers.Accept, "application/json");
  });
}

// ---------------------------------------------------------------------------
// bad_request guards — blank required fields, before any transport call.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: degraded(bad_request) when a required field is blank, before any transport call`, async () => {
    const transport = fakeTransport(() => ({ status: 200, json: async () => c.successBody }));
    for (const field of c.requiredFields) {
      for (const blank of ["", "   "]) {
        const args = { ...c.validArgs, [field]: blank };
        const res = await c.fn({ env: ENV, ...args, transport });
        assert.equal(res.degraded, true, `${c.name} blank ${field}=${JSON.stringify(blank)}`);
        assert.equal(res.reason, "bad_request", `${c.name} blank ${field}=${JSON.stringify(blank)}`);
      }
    }
    assert.equal(transport.calls.length, 0, `${c.name} must not call transport on a bad_request guard`);
  });
}

// ---------------------------------------------------------------------------
// config_missing — before any transport call.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: degraded(config_missing) with the missing vars when console is unconfigured`, async () => {
    const transport = fakeTransport(() => ({ status: 200, json: async () => c.successBody }));
    const res = await c.fn({ env: {}, ...c.validArgs, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "config_missing");
    assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
    assert.equal(transport.calls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// transport throws -> unreachable, single attempt, no leaked error text.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: degraded(unreachable) when the transport throws — one attempt, no retry, no leaked text`, async () => {
    const transport = fakeTransport(() => {
      throw new Error("ECONNREFUSED 10.0.0.1:443 — secret-looking internal detail");
    });
    const res = await c.fn({ env: ENV, ...c.validArgs, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "unreachable");
    assert.equal(transport.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(res), /ECONNREFUSED|10\.0\.0\.1|secret-looking/);
  });
}

// ---------------------------------------------------------------------------
// status table spot-checks (404/409/429/500) — mapped reason, status carried,
// token never leaked.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: degraded maps each spot-checked non-2xx status and carries status, without the token`, async () => {
    const spotChecks = [
      [404, "not_found"],
      [409, "conflict"],
      [429, "rate_limited"],
      [500, "upstream_error"],
    ];
    for (const [status, reason] of spotChecks) {
      const transport = fakeTransport(() => ({ status, json: async () => ({}) }));
      const res = await c.fn({ env: ENV, ...c.validArgs, transport });
      assert.equal(res.degraded, true, `${c.name} status ${status} must degrade`);
      assert.equal(res.reason, reason, `${c.name} status ${status} -> ${reason}`);
      assert.equal(res.status, status);
      assert.equal(transport.calls.length, 1);
      assert.doesNotMatch(JSON.stringify(res), /tok-secret-123/);
    }
  });
}

// ---------------------------------------------------------------------------
// bad_body — 200 with a body that fails to parse as JSON.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: degraded(bad_body) when the console responds 200 with non-JSON`, async () => {
    const transport = fakeTransport(() => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    const res = await c.fn({ env: ENV, ...c.validArgs, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "bad_body");
    assert.equal(res.status, 200);
  });
}

// ---------------------------------------------------------------------------
// success pass-through + coercion defaults on a malformed 2xx body.
// ---------------------------------------------------------------------------

for (const c of CASES) {
  test(`${c.name}: success pass-through with the console's actual body shape`, async () => {
    const transport = fakeTransport(() => ({ status: 200, json: async () => c.successBody }));
    const res = await c.fn({ env: ENV, ...c.validArgs, transport });
    assert.equal(res.ok, true);
    c.assertSuccess(res);
  });

  test(`${c.name}: a malformed 2xx body coerces to safe empty defaults rather than throwing`, async () => {
    const transport = fakeTransport(() => ({ status: 200, json: async () => ({}) }));
    const res = await c.fn({ env: ENV, ...c.validArgs, transport });
    assert.equal(res.ok, true);
    c.assertEmptyBodyDefaults(res);
  });

  test(`${c.name}: a non-object 2xx body (null) is treated as bad_body, never throws`, async () => {
    const transport = fakeTransport(() => ({ status: 200, json: async () => null }));
    const res = await c.fn({ env: ENV, ...c.validArgs, transport });
    assert.equal(res.degraded, true);
    assert.equal(res.reason, "bad_body");
  });
}

// ---------------------------------------------------------------------------
// read_repo_file — optional `ref`.
// ---------------------------------------------------------------------------

test("read_repo_file: includes ref in the URL when given, and echoes it back", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ path: "src/index.ts", ref: "main", kind: "file", content: "x", size: 1, truncated: false }),
  }));
  const res = await ReadRepoFile.readRepoFile({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    path: "src/index.ts",
    ref: "main",
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.ref, "main");
  assert.equal(
    transport.calls[0].url,
    `${ENV.JACE_CONSOLE_BASE_URL}${ReadRepoFile.REPO_FILE_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&path=src%2Findex.ts&ref=main`,
  );
});

test("read_repo_file: omits ref from the URL when blank/absent", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ path: "src/index.ts", ref: "", kind: "file", content: "x", size: 1, truncated: false }),
  }));
  await ReadRepoFile.readRepoFile({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    path: "src/index.ts",
    transport,
  });
  assert.doesNotMatch(transport.calls[0].url, /ref=/);
});

test("read_repo_file: a dir body's entries pass through array-or-[]; content/size/truncated default", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ path: "src", ref: "", kind: "dir", entries: [{ name: "index.ts", type: "file" }] }),
  }));
  const res = await ReadRepoFile.readRepoFile({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    path: "src",
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "dir");
  assert.deepEqual(res.entries, [{ name: "index.ts", type: "file" }]);
  assert.equal(res.content, "");
  assert.equal(res.size, 0);
  assert.equal(res.truncated, false);
});

test("read_repo_file: truncated coerces via strict === true (any other value is false)", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ path: "src/index.ts", ref: "", kind: "file", content: "x", size: 1, truncated: "yes" }),
  }));
  const res = await ReadRepoFile.readRepoFile({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    path: "src/index.ts",
    transport,
  });
  assert.equal(res.truncated, false);
});

// ---------------------------------------------------------------------------
// file_history — optional `limit`.
// ---------------------------------------------------------------------------

test("file_history: includes limit in the URL when given as a positive number", async () => {
  const transport = fakeTransport(() => ({ status: 200, json: async () => ({ path: "src/index.ts", commits: [] }) }));
  await FileHistory.fileHistory({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    path: "src/index.ts",
    limit: 5,
    transport,
  });
  assert.equal(
    transport.calls[0].url,
    `${ENV.JACE_CONSOLE_BASE_URL}${FileHistory.FILE_HISTORY_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&path=src%2Findex.ts&limit=5`,
  );
});

test("file_history: omits limit from the URL when absent, zero, negative, or non-numeric", async () => {
  for (const limit of [undefined, 0, -1, NaN, "abc"]) {
    const t = fakeTransport(() => ({ status: 200, json: async () => ({ path: "src/index.ts", commits: [] }) }));
    await FileHistory.fileHistory({
      env: ENV,
      eveSessionId: "eve-1",
      repo: "ada/widgets",
      path: "src/index.ts",
      limit,
      transport: t,
    });
    assert.doesNotMatch(t.calls[0].url, /limit=/, `limit=${JSON.stringify(limit)} must not appear in the URL`);
  }
});

// ---------------------------------------------------------------------------
// fetch_wiki — mode derivation (slug -> get, query -> search, neither -> list,
// slug wins when both are given).
// ---------------------------------------------------------------------------

test("deriveWikiMode: slug->get, query->search, neither->list, slug wins over query", () => {
  assert.equal(FetchWiki.deriveWikiMode("runner-routes", undefined), "get");
  assert.equal(FetchWiki.deriveWikiMode(undefined, "auth flow"), "search");
  assert.equal(FetchWiki.deriveWikiMode(undefined, undefined), "list");
  assert.equal(FetchWiki.deriveWikiMode("", ""), "list");
  assert.equal(FetchWiki.deriveWikiMode("   ", "   "), "list");
  assert.equal(FetchWiki.deriveWikiMode("runner-routes", "auth flow"), "get");
});

test("fetch_wiki: slug given -> mode=get, slug carried in the URL", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ schemaVersion: 1, repo: "ada/widgets", mode: "get", pages: [{ slug: "runner-routes" }] }),
  }));
  const res = await FetchWiki.fetchWiki({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    slug: "runner-routes",
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "get");
  assert.equal(
    transport.calls[0].url,
    `${ENV.JACE_CONSOLE_BASE_URL}${FetchWiki.REPO_WIKI_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&mode=get&slug=runner-routes`,
  );
});

test("fetch_wiki: query given (no slug) -> mode=search, query carried in the URL", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ schemaVersion: 1, repo: "ada/widgets", mode: "search", pages: [] }),
  }));
  const res = await FetchWiki.fetchWiki({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    query: "auth flow",
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "search");
  assert.equal(
    transport.calls[0].url,
    `${ENV.JACE_CONSOLE_BASE_URL}${FetchWiki.REPO_WIKI_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&mode=search&query=auth+flow`,
  );
});

test("fetch_wiki: neither slug nor query -> mode=list, neither param in the URL", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ schemaVersion: 1, repo: "ada/widgets", mode: "list", pages: [] }),
  }));
  const res = await FetchWiki.fetchWiki({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    transport,
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "list");
  assert.equal(
    transport.calls[0].url,
    `${ENV.JACE_CONSOLE_BASE_URL}${FetchWiki.REPO_WIKI_PATH}?eveSessionId=eve-1&repo=ada%2Fwidgets&mode=list`,
  );
  assert.doesNotMatch(transport.calls[0].url, /slug=|query=/);
});

test("fetch_wiki: both slug and query given -> slug wins (mode=get), query dropped from the URL", async () => {
  const transport = fakeTransport(() => ({
    status: 200,
    json: async () => ({ schemaVersion: 1, repo: "ada/widgets", mode: "get", pages: [{ slug: "runner-routes" }] }),
  }));
  const res = await FetchWiki.fetchWiki({
    env: ENV,
    eveSessionId: "eve-1",
    repo: "ada/widgets",
    slug: "runner-routes",
    query: "auth flow",
    transport,
  });
  assert.equal(res.mode, "get");
  assert.match(transport.calls[0].url, /mode=get/);
  assert.match(transport.calls[0].url, /slug=runner-routes/);
  assert.doesNotMatch(transport.calls[0].url, /query=/);
});

// ---------------------------------------------------------------------------
// fetch_wiki's conflict note is DELIBERATELY narrower than its three siblings
// (see its own conflictNoteChecks comment above): repo-wiki never calls
// GitHub, so it has no reclassified-401/403 case to name. This pins that the
// distinction is intentional, not a copy/paste miss when the sibling cores'
// conflict notes were widened to mention stale/revoked GitHub App installs.
// ---------------------------------------------------------------------------

test("fetch_wiki: conflict note stays workspace-only — no stale/revoked GitHub App language (repo-wiki never calls GitHub)", () => {
  const d = FetchWiki.degraded("conflict");
  assert.doesNotMatch(
    d.note,
    /stale|revoked|GitHub App/i,
    `fetch_wiki's conflict note must not invent a GitHub-credentials case repo-wiki cannot produce, got: ${d.note}`,
  );
});
