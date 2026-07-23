// Unit tests for the pure backlog-grooming signal helpers (issue #1291).
// No I/O, no clock of their own — `now` is always injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIsoMs,
  daysBetween,
  ageInDays,
  stalenessInDays,
  titleTokens,
  jaccardSimilarity,
  findLikelyDuplicateGroups,
  impactLabels,
  DEFAULT_DUPLICATE_THRESHOLD,
} from "../agent/lib/backlog_triage.core.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-23T00:00:00.000Z");

test("parseIsoMs parses a real ISO string and rejects junk/empty", () => {
  assert.equal(parseIsoMs("2026-07-23T00:00:00.000Z"), NOW);
  assert.equal(parseIsoMs(""), null);
  assert.equal(parseIsoMs("   "), null);
  assert.equal(parseIsoMs("not-a-date"), null);
  assert.equal(parseIsoMs(undefined), null);
  assert.equal(parseIsoMs(12345), null);
});

test("daysBetween floors whole days and never goes negative", () => {
  assert.equal(daysBetween(new Date(NOW - 10 * DAY).toISOString(), NOW), 10);
  // 10 days + 12h ago still floors to 10
  assert.equal(daysBetween(new Date(NOW - 10 * DAY - 12 * 60 * 60 * 1000).toISOString(), NOW), 10);
  // a future timestamp clamps to 0, never negative
  assert.equal(daysBetween(new Date(NOW + 5 * DAY).toISOString(), NOW), 0);
});

test("daysBetween returns null (unknown signal) for an unparseable date — never 0", () => {
  assert.equal(daysBetween("", NOW), null);
  assert.equal(daysBetween(undefined, NOW), null);
});

test("ageInDays / stalenessInDays are daysBetween over created_at / updated_at", () => {
  const created = new Date(NOW - 90 * DAY).toISOString();
  const updated = new Date(NOW - 3 * DAY).toISOString();
  assert.equal(ageInDays(created, NOW), 90);
  assert.equal(stalenessInDays(updated, NOW), 3);
});

test("titleTokens lowercases, strips punctuation, and drops stopwords + 1-char tokens", () => {
  const tokens = titleTokens("Fix the Session-cookie LEAK across tenants!");
  // "fix", "the", "across" are stopwords/short and dropped; content words remain
  assert.ok(tokens.has("session"));
  assert.ok(tokens.has("cookie"));
  assert.ok(tokens.has("leak"));
  assert.ok(tokens.has("tenants"));
  assert.ok(!tokens.has("the"));
  assert.ok(!tokens.has("fix"));
});

test("jaccardSimilarity: identical token sets = 1, disjoint = 0, two empties = 0", () => {
  const a = titleTokens("session cookie leak tenants");
  const b = titleTokens("session cookie leak tenants");
  assert.equal(jaccardSimilarity(a, b), 1);
  assert.equal(jaccardSimilarity(titleTokens("apples oranges"), titleTokens("rockets planets")), 0);
  assert.equal(jaccardSimilarity(titleTokens(""), titleTokens("")), 0);
  assert.equal(jaccardSimilarity(null, undefined), 0);
});

test("jaccardSimilarity is between 0 and 1 for partial overlap", () => {
  const sim = jaccardSimilarity(
    titleTokens("session cookie leaks across tenants"),
    titleTokens("cookie leak between tenants"),
  );
  assert.ok(sim > 0 && sim < 1, `expected partial overlap, got ${sim}`);
});

test("findLikelyDuplicateGroups clusters similar titles and ignores dissimilar ones", () => {
  const issues = [
    { repo: "o/r", number: 1, title: "Session cookie leaks across tenants" },
    { repo: "o/r", number: 2, title: "Cookie leak across tenants in session" },
    { repo: "o/r", number: 3, title: "Dark mode toggle flicker on load" },
  ];
  const groups = findLikelyDuplicateGroups(issues, 0.4);
  assert.equal(groups.length, 1, "exactly one duplicate group");
  const members = groups[0].members.map((m) => m.number).sort();
  assert.deepEqual(members, [1, 2]);
  assert.ok(groups[0].maxSimilarity > 0);
});

test("findLikelyDuplicateGroups single-linkage clusters a transitive component across repos", () => {
  const issues = [
    { repo: "o/a", number: 10, title: "webhook retry storm on 500 errors" },
    { repo: "o/a", number: 11, title: "retry storm webhook 500" },
    { repo: "o/b", number: 12, title: "webhook 500 retry storm cascade" },
    { repo: "o/b", number: 20, title: "totally unrelated typography bug" },
  ];
  const groups = findLikelyDuplicateGroups(issues, 0.4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.number).sort((x, y) => x - y), [10, 11, 12]);
});

test("findLikelyDuplicateGroups returns [] when nothing is similar, and tolerates junk input", () => {
  assert.deepEqual(
    findLikelyDuplicateGroups([
      { repo: "o/r", number: 1, title: "alpha beta" },
      { repo: "o/r", number: 2, title: "gamma delta" },
    ]),
    [],
  );
  assert.deepEqual(findLikelyDuplicateGroups(null), []);
  assert.deepEqual(findLikelyDuplicateGroups([]), []);
});

test("DEFAULT_DUPLICATE_THRESHOLD is a conservative 0..1 value", () => {
  assert.ok(DEFAULT_DUPLICATE_THRESHOLD > 0 && DEFAULT_DUPLICATE_THRESHOLD <= 1);
});

test("impactLabels picks impact/priority labels case-insensitively and by substring", () => {
  assert.deepEqual(impactLabels(["security"]), ["security"]);
  assert.deepEqual(impactLabels(["Priority: High"]), ["Priority: High"]);
  assert.deepEqual(impactLabels(["P1-bug"]), ["P1-bug"]);
  assert.deepEqual(impactLabels(["kind/regression"]), ["kind/regression"]);
  // non-impact labels are dropped
  assert.deepEqual(impactLabels(["documentation", "good first issue"]), []);
  assert.deepEqual(impactLabels(null), []);
});
