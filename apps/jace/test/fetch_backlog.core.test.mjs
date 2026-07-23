// Unit tests for Jace's READ-ONLY backlog fetch core (issue #1291). Pure,
// injected transport — no live console.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBacklogUrl,
  classifyStatus,
  degraded,
  projectIssue,
  fetchBacklog,
  BACKLOG_PATH,
} from "../agent/lib/fetch_backlog.core.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-23T00:00:00.000Z");

const ENV = {
  JACE_CONSOLE_BASE_URL: "https://console.example.com",
  JACE_CONSOLE_TOKEN: "tok-secret-123",
};

function okResponse(body) {
  return { status: 200, json: async () => body };
}

function issue(overrides = {}) {
  return {
    repo: "o/r",
    number: 1,
    title: "An issue",
    labels: ["bug"],
    createdAt: new Date(NOW - 30 * DAY).toISOString(),
    updatedAt: new Date(NOW - 5 * DAY).toISOString(),
    comments: 2,
    bodyExcerpt: "some body",
    ...overrides,
  };
}

test("buildBacklogUrl joins base + path + eveSessionId query (encoded)", () => {
  assert.equal(
    buildBacklogUrl("https://console.example.com", "eve session 1"),
    `https://console.example.com${BACKLOG_PATH}?eveSessionId=eve%20session%201`,
  );
  // blank session -> no query (the caller guards blank before this is reached)
  assert.equal(buildBacklogUrl("https://console.example.com", ""), `https://console.example.com${BACKLOG_PATH}`);
});

test("classifyStatus maps status families", () => {
  assert.deepEqual(classifyStatus(200), { ok: true });
  assert.equal(classifyStatus(400).reason, "bad_request");
  assert.equal(classifyStatus(401).reason, "unauthorized");
  assert.equal(classifyStatus(403).reason, "unauthorized");
  assert.equal(classifyStatus(404).reason, "not_connected");
  assert.equal(classifyStatus(409).reason, "not_connected");
  assert.equal(classifyStatus(500).reason, "upstream_error");
  assert.equal(classifyStatus(418).reason, "unexpected_status");
});

test("degraded carries a stable reason + cause-free note, never transport text", () => {
  const d = degraded("unreachable", { status: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.degraded, true);
  assert.equal(d.reason, "unreachable");
  assert.match(d.note, /could not be reached/i);
});

test("projectIssue enriches with ageDays/stalenessDays/impactLabels and hardens untrusted fields", () => {
  const p = projectIssue(
    issue({
      title: "Leak​ in session, ping @everyone",
      labels: ["security", "docs"],
      createdAt: new Date(NOW - 90 * DAY).toISOString(),
      updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    }),
    NOW,
  );
  assert.equal(p.ageDays, 90);
  assert.equal(p.stalenessDays, 2);
  assert.deepEqual(p.impactLabels, ["security"]);
  // hardened: zero-width stripped, @everyone defanged
  assert.ok(!/​/.test(p.title), "zero-width stripped from title");
  assert.ok(!/@everyone/.test(p.title), "live @everyone defanged in title");
});

test("projectIssue leaves ageDays null when created_at is missing (unknown, not zero)", () => {
  const p = projectIssue(issue({ createdAt: "" }), NOW);
  assert.equal(p.ageDays, null);
});

test("fetchBacklog: blank eveSessionId -> degraded('bad_request'), transport never called", async () => {
  let called = false;
  const res = await fetchBacklog({
    eveSessionId: "   ",
    env: ENV,
    now: NOW,
    transport: async () => {
      called = true;
      return okResponse({ issues: [] });
    },
  });
  assert.equal(res.reason, "bad_request");
  assert.equal(called, false);
});

test("fetchBacklog: unset console config -> degraded('config_missing') with missing vars", async () => {
  const res = await fetchBacklog({
    eveSessionId: "eve-1",
    env: {},
    now: NOW,
    transport: async () => okResponse({ issues: [] }),
  });
  assert.equal(res.reason, "config_missing");
  assert.deepEqual(res.missing, ["JACE_CONSOLE_BASE_URL", "JACE_CONSOLE_TOKEN"]);
});

test("fetchBacklog: transport throws -> degraded('unreachable'), never throws", async () => {
  const res = await fetchBacklog({
    eveSessionId: "eve-1",
    env: ENV,
    now: NOW,
    transport: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(res.reason, "unreachable");
});

test("fetchBacklog: 409 (no repo connected) -> degraded('not_connected')", async () => {
  const res = await fetchBacklog({
    eveSessionId: "eve-1",
    env: ENV,
    now: NOW,
    transport: async () => ({ status: 409, json: async () => ({ error: "no repo" }) }),
  });
  assert.equal(res.reason, "not_connected");
  assert.equal(res.status, 409);
});

test("fetchBacklog: non-JSON body -> degraded('bad_body')", async () => {
  const res = await fetchBacklog({
    eveSessionId: "eve-1",
    env: ENV,
    now: NOW,
    transport: async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }),
  });
  assert.equal(res.reason, "bad_body");
});

test("fetchBacklog: success projects + enriches + computes duplicate groups + auth header", async () => {
  let seenInit = null;
  const body = {
    issues: [
      issue({ number: 1, title: "Session cookie leaks across tenants", labels: ["security"] }),
      issue({ number: 2, title: "Cookie leak across tenants in session", labels: [] }),
      issue({ number: 3, title: "Dark mode toggle flicker", labels: ["ui"] }),
    ],
    repos: ["o/r"],
    warnings: [],
  };
  const res = await fetchBacklog({
    eveSessionId: "eve-1",
    env: ENV,
    now: NOW,
    transport: async (_url, init) => {
      seenInit = init;
      return okResponse(body);
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  assert.deepEqual(res.repos, ["o/r"]);
  assert.equal(res.issues[0].impactLabels.length, 1); // #1 has security
  // #1 and #2 are near-duplicate titles -> one group
  assert.equal(res.likelyDuplicateGroups.length, 1);
  assert.deepEqual(
    res.likelyDuplicateGroups[0].members.map((m) => m.number).sort(),
    [1, 2],
  );
  assert.equal(seenInit.headers.Authorization, "Bearer tok-secret-123");
});

test("fetchBacklog: malformed success body (no issues array) -> empty, not a throw", async () => {
  const res = await fetchBacklog({
    eveSessionId: "eve-1",
    env: ENV,
    now: NOW,
    transport: async () => okResponse({ nope: true }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.deepEqual(res.issues, []);
  assert.deepEqual(res.likelyDuplicateGroups, []);
});
