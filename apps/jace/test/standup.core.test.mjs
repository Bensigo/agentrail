// AC1 + AC2 — the standup reports ONLY schema-backed facts, and never a reason.
//
// AC1: every field a standup emits is derived solely from a real, schema-backed
//      column. This test ENUMERATES the allowed field set and FAILS if
//      buildStandup/renderStandup surfaces any claim outside it — in particular
//      any "error"/"reason"/"why" narrative, which has no backing column.
//
// AC2: "why did run X fail" returns an honest "no failure-detail source"
//      answer that reports only what IS known (state, cost, PR link) and never
//      confabulates a reason.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUNS_ALLOWED_FIELDS,
  QUEUE_ALLOWED_FIELDS,
  STANDUP_ALLOWED_FIELDS,
  RUN_STATES,
  ESCALATED_STATE,
  WHY_FAILED_NO_SOURCE,
  buildStandup,
  renderStandup,
  answerWhyFailed,
} from "../agent/lib/standup.core.mjs";

// A representative snapshot with every run state, a couple of PR links, some
// cost, and one escalated queue entry.
const RUNS = [
  { id: "r1", status: "success", costUsd: 0.5, prUrl: "https://gh/pr/1", title: "a", branch: "b1", agent: "opus", createdAt: "t1" },
  { id: "r2", status: "failed", costUsd: 1.25, prUrl: "", title: "b", branch: "b2", agent: "opus", createdAt: "t2" },
  { id: "r3", status: "running", costUsd: 0.25, prUrl: "https://gh/pr/3", title: "c", branch: "b3", agent: "sonnet", createdAt: "t3" },
  { id: "r4", status: "queued", costUsd: 0, prUrl: "", title: "d", branch: "b4", agent: "opus", createdAt: "t4" },
];
const QUEUE = [
  { id: "q1", state: "queued", title: "Q1", externalId: "#10", tier: 1 },
  { id: "q2", state: ESCALATED_STATE, title: "Q2", externalId: "#11", tier: 2 },
  { id: "q3", state: "green", title: "Q3", externalId: "#12", tier: 1 },
];

// ── AC1 ──────────────────────────────────────────────────────────────────────

test("AC1: STANDUP_ALLOWED_FIELDS is the enumerated schema-backed field set", () => {
  // The allowed field set is the exact union of the two per-table sets, and it
  // deliberately contains NO error/reason/why field.
  assert.deepEqual(STANDUP_ALLOWED_FIELDS, [
    ...RUNS_ALLOWED_FIELDS.map((f) => `runs.${f}`),
    ...QUEUE_ALLOWED_FIELDS.map((f) => `queue_entries.${f}`),
  ]);
  const forbidden = /error|reason|why|failure|log/i;
  for (const field of STANDUP_ALLOWED_FIELDS) {
    assert.ok(
      !forbidden.test(field),
      `allowed field "${field}" looks like a failure-narrative source; none exists in schema`,
    );
  }
});

test("AC1: buildStandup derives every field from an allowed schema-backed column", () => {
  const standup = buildStandup({ runs: RUNS, queueEntries: QUEUE });

  // Run counts by state: only the four enum values, each seeded to a number.
  assert.deepEqual(Object.keys(standup.runCountsByState).sort(), [...RUN_STATES].sort());
  assert.equal(standup.runCountsByState.success, 1);
  assert.equal(standup.runCountsByState.failed, 1);
  assert.equal(standup.runCountsByState.running, 1);
  assert.equal(standup.runCountsByState.queued, 1);

  assert.equal(standup.totalRuns, 4);
  assert.equal(standup.totalCostUsd, 2.0); // 0.5 + 1.25 + 0.25 + 0
  assert.deepEqual(standup.prLinks, ["https://gh/pr/1", "https://gh/pr/3"]);

  // Exactly one escalation, echoing only allowed queue columns.
  assert.equal(standup.escalations.length, 1);
  assert.deepEqual(Object.keys(standup.escalations[0]).sort(), ["externalId", "id", "title"]);
  assert.equal(standup.escalations[0].id, "q2");

  // The standup object exposes NO reason/why/error key anywhere.
  const json = JSON.stringify(standup);
  assert.ok(!/reason|"why"|"error"|failureSummary/i.test(json), json);
});

test("AC1: buildStandup ignores an injected non-schema 'reason' column", () => {
  // Even if a row somehow carried a bogus reason/error field, the standup must
  // not surface it — the output is built ONLY from enumerated columns.
  const poisoned = [
    { id: "r9", status: "failed", costUsd: 3, prUrl: "", reason: "OOM killed", error: "boom", why: "flaky" },
  ];
  const standup = buildStandup({ runs: poisoned, queueEntries: [] });
  const json = JSON.stringify(standup);
  assert.ok(!/OOM killed|boom|flaky/.test(json), `leaked a non-schema field: ${json}`);
  assert.equal(standup.runCountsByState.failed, 1);
});

test("AC1: renderStandup prints only allowed facts (no reason narrative)", () => {
  const text = renderStandup(buildStandup({ runs: RUNS, queueEntries: QUEUE }));
  assert.match(text, /Runs: 4 total/);
  assert.match(text, /Total cost: \$2\.00/);
  assert.match(text, /Open PRs: 2/);
  assert.match(text, /Escalations .*: 1/);
  // No failure-narrative vocabulary in the rendered report.
  assert.ok(!/because|reason:|failed because|error:/i.test(text), text);
});

// ── AC2 ──────────────────────────────────────────────────────────────────────

test("AC2: answerWhyFailed returns the honest no-source answer with only known facts", () => {
  const run = { id: "r2", status: "failed", costUsd: 1.25, prUrl: "https://gh/pr/2", reason: "should be ignored" };
  const ans = answerWhyFailed(run);

  assert.equal(ans.hasFailureReason, false);
  assert.equal(ans.message, WHY_FAILED_NO_SOURCE);
  // Only schema-backed known facts are echoed — never a reason.
  assert.deepEqual(Object.keys(ans.known).sort(), ["costUsd", "id", "prUrl", "status"]);
  assert.equal(ans.known.status, "failed");
  assert.equal(ans.known.costUsd, 1.25);
  assert.equal(ans.known.prUrl, "https://gh/pr/2");

  const json = JSON.stringify(ans);
  assert.ok(!/should be ignored/.test(json), `confabulated/leaked a reason: ${json}`);
});

test("AC2: the no-source message explicitly refuses to invent a reason", () => {
  // The fixed message must say there is no source AND promise not to invent one.
  assert.match(WHY_FAILED_NO_SOURCE, /no (error|failure)/i);
  assert.match(WHY_FAILED_NO_SOURCE, /will not\s+invent a reason/i);
});

test("AC2: answerWhyFailed on an unknown run still refuses to guess", () => {
  const ans = answerWhyFailed(undefined);
  assert.equal(ans.hasFailureReason, false);
  assert.equal(ans.message, WHY_FAILED_NO_SOURCE);
  assert.equal(ans.known, null);
});
