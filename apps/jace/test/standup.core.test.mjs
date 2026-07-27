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
//
// Also (Task 9 — retiring standup's direct-Postgres edge onto the console's
// workspace-scoped work-status route):
//
//   Part 2: renderStandup's truncation honesty — a truncated page (the
//   console route caps how many rows it returns) must never be rendered as
//   if it were the complete history.
//
//   Part 3: buildStandupOutcome — the pure orchestration the standup TOOL
//   (agent/tools/standup.ts) now delegates to, given an already-fetched
//   fetchWorkStatus-shaped result (ok or degraded) instead of a fake SQL
//   driver. This is what makes the tool's degraded-passthrough, truncation
//   threading, and whyFailedRunId lookup unit-testable without a live fetch
//   or mocking the fetchWorkStatus module (this repo's "injected dependency,
//   no module mocking" convention — see instrumentation.test.mjs's header).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  buildStandupOutcome,
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

// ── Part 2: renderStandup truncation honesty ────────────────────────────────

test("renderStandup with no truncated arg (or all-false) renders exactly as before — 'N total'", () => {
  const standup = buildStandup({ runs: RUNS, queueEntries: QUEUE });
  const withoutArg = renderStandup(standup);
  const withFalseFlags = renderStandup(standup, { truncated: { runs: false, queueEntries: false } });
  assert.equal(withoutArg, withFalseFlags);
  assert.match(withoutArg, /Runs: 4 total/);
  assert.match(withoutArg, /Queue states:\n/);
  assert.doesNotMatch(withoutArg, /most recent|truncated/i);
});

test("renderStandup says so — 'most recent', not 'N total' — when truncated.runs is true", () => {
  const standup = buildStandup({ runs: RUNS, queueEntries: QUEUE });
  const text = renderStandup(standup, { truncated: { runs: true } });
  // The exact regression named by the task: never "Runs: 4 total" once truncated.
  assert.doesNotMatch(text, /Runs: 4 total/);
  assert.match(text, /Runs: 4 most recent.*truncated/);
  assert.match(text, /not the complete history/i);
  assert.match(text, /Note:.*runs.*most recent page/i);
});

test("renderStandup flags queue-entries truncation on the 'Queue states' header", () => {
  const standup = buildStandup({ runs: RUNS, queueEntries: QUEUE });
  const text = renderStandup(standup, { truncated: { queueEntries: true } });
  assert.doesNotMatch(text, /^Queue states:$/m);
  assert.match(text, /Queue states \(most recent — truncated, not the complete history\):/);
  // Runs line is untouched when only queueEntries is truncated.
  assert.match(text, /Runs: 4 total/);
  assert.match(text, /Note:.*queue entries.*most recent page/i);
});

test("renderStandup flags BOTH runs and queue entries truncation together", () => {
  const standup = buildStandup({ runs: RUNS, queueEntries: QUEUE });
  const text = renderStandup(standup, { truncated: { runs: true, queueEntries: true } });
  assert.match(text, /Runs: 4 most recent/);
  assert.match(text, /Queue states \(most recent/);
  assert.match(text, /Note: the runs and queue entries above/);
});

// ── Part 3: buildStandupOutcome — the tool's orchestration, pure ───────────

test("buildStandupOutcome returns a degraded fetchWorkStatus result VERBATIM, never an empty report", () => {
  const degraded = {
    ok: false,
    degraded: true,
    reason: "unreachable",
    note: "The console work-status endpoint could not be reached.",
  };
  const outcome = buildStandupOutcome({ status: degraded, whyFailedRunId: undefined });
  // Same object, not rebuilt/rewrapped — and critically, no `report`/`standup`
  // keys that would make this look like a (fake, empty) rendered standup.
  assert.equal(outcome, degraded);
  assert.equal("report" in outcome, false);
  assert.equal("standup" in outcome, false);
});

test("buildStandupOutcome on an ok status builds+renders the standup and threads truncated through", () => {
  const status = {
    ok: true,
    runs: RUNS,
    queueEntries: QUEUE,
    truncated: { runs: true, queueEntries: false },
  };
  const outcome = buildStandupOutcome({ status });
  assert.equal(outcome.standup.totalRuns, 4);
  assert.match(outcome.report, /Runs: 4 most recent.*truncated/);
  assert.equal(outcome.failureReasonPolicy, WHY_FAILED_NO_SOURCE);
  assert.deepEqual(outcome.truncated, { runs: true, queueEntries: false });
  assert.equal(outcome.whyFailed, null); // no whyFailedRunId given
});

test("buildStandupOutcome resolves whyFailedRunId via whyFailedStatus (found)", () => {
  const status = { ok: true, runs: RUNS, queueEntries: QUEUE, truncated: { runs: false, queueEntries: false } };
  // Minor 5: whyFailedStatus is REQUIRED whenever whyFailedRunId is set —
  // there is no more fallback that searches status.runs on its own.
  const whyFailedStatus = { ok: true, runs: [RUNS.find((r) => r.id === "r2")], queueEntries: [] };
  const outcome = buildStandupOutcome({ status, whyFailedRunId: "r2", whyFailedStatus });
  assert.equal(outcome.whyFailed.hasFailureReason, false);
  assert.equal(outcome.whyFailed.message, WHY_FAILED_NO_SOURCE);
  assert.equal(outcome.whyFailed.known.id, "r2");
  assert.equal(outcome.whyFailed.known.status, "failed");
});

// ── Important 1: "no such run" vs "no reason recorded" are DIFFERENT claims ─
//
// When the dedicated whyFailedStatus lookup succeeds (ok: true) but the id
// matches no row in it, that means the run id itself doesn't resolve in this
// workspace — a claim about the LOOKUP. answerWhyFailed(undefined)'s
// WHY_FAILED_NO_SOURCE message asserts the OPPOSITE: that the run exists and
// simply has no recorded reason. Collapsing the two would tell a human "no
// failure reason is recorded for that run" about a run that was never found.

test("buildStandupOutcome distinguishes 'no such run' from 'no reason recorded' (Important 1)", () => {
  const status = { ok: true, runs: RUNS, queueEntries: QUEUE, truncated: { runs: false, queueEntries: false } };
  // The dedicated lookup completed fine (ok: true) — it just found nothing
  // for this id, which is a meaningful, exact-and-unpaginated "not in this
  // workspace" result, not a partial/page-limited miss.
  const whyFailedStatus = { ok: true, runs: [], queueEntries: [] };
  const outcome = buildStandupOutcome({ status, whyFailedRunId: "does-not-exist", whyFailedStatus });

  assert.equal(outcome.whyFailed.hasFailureReason, false);
  assert.equal(outcome.whyFailed.notFound, true);
  assert.equal(outcome.whyFailed.known, null);
  assert.match(outcome.whyFailed.message, /found no such run/);
  assert.match(outcome.whyFailed.message, /does-not-exist/);
  // Must NOT be the "run exists but no reason recorded" message — that
  // asserts something false about a run id that doesn't resolve at all.
  assert.notEqual(outcome.whyFailed.message, WHY_FAILED_NO_SOURCE);
});

// ── Important 4: whyFailedRunId via a dedicated, unpaginated ref lookup ────
//
// The aggregate `status.runs` above is only ever a PAGE (STANDUP_LIMIT rows
// off the top of the standup.ts fetch) — a failed run older than that page
// is invisible to the fallback search above and would read identically to
// "no such run". The fix: agent/tools/standup.ts makes a SECOND, targeted
// fetchWorkStatus({ ref: whyFailedRunId }) call, which the console route
// resolves EXACTLY and unpaginated via findWorkspaceWorkByRef's `run-id`
// branch. That result is passed in here as `whyFailedStatus`.

test("buildStandupOutcome resolves whyFailedRunId via the dedicated whyFailedStatus fetch, reaching a run OUTSIDE the aggregate page", () => {
  const status = { ok: true, runs: RUNS, queueEntries: QUEUE, truncated: { runs: true, queueEntries: false } };
  // Not present anywhere in `status.runs` — only the dedicated, unpaginated
  // ref=<runId> fetch can find it.
  const whyFailedStatus = {
    ok: true,
    runs: [{ id: "old-run-outside-page", status: "failed", costUsd: 4, prUrl: "https://gh/pr/99" }],
    queueEntries: [],
  };
  const outcome = buildStandupOutcome({
    status,
    whyFailedRunId: "old-run-outside-page",
    whyFailedStatus,
  });
  assert.equal(outcome.whyFailed.hasFailureReason, false);
  assert.equal(outcome.whyFailed.message, WHY_FAILED_NO_SOURCE);
  assert.equal(outcome.whyFailed.known.id, "old-run-outside-page");
  assert.equal(outcome.whyFailed.known.status, "failed");
});

test("buildStandupOutcome reports a degraded whyFailedStatus fetch honestly — never a fabricated 'no such run'", () => {
  const status = { ok: true, runs: RUNS, queueEntries: QUEUE, truncated: { runs: false, queueEntries: false } };
  const whyFailedStatus = {
    ok: false,
    degraded: true,
    reason: "unreachable",
    note: "The console work-status endpoint could not be reached (network error); no status could be fetched. Do not retry from here.",
  };
  const outcome = buildStandupOutcome({ status, whyFailedRunId: "r2", whyFailedStatus });
  assert.equal(outcome.whyFailed.degraded, true);
  assert.equal(outcome.whyFailed.reason, "unreachable");
  assert.equal(outcome.whyFailed.message, whyFailedStatus.note);
  assert.equal(outcome.whyFailed.known, null);
  // Must not silently claim "no failure reason on record" for a lookup that
  // never actually completed.
  assert.notEqual(outcome.whyFailed.hasFailureReason, true);
});

test("Minor 5: buildStandupOutcome does NOT fall back to searching status.runs when whyFailedRunId is set without whyFailedStatus", () => {
  // The page-limited "search status.runs" fallback was retired — it
  // re-implemented exactly the page-limited search the dedicated
  // whyFailedStatus lookup exists to fix, and standup.ts always supplies
  // whyFailedStatus (a real dedicated fetch, or one built from a row
  // already in hand — Minor 7) whenever whyFailedRunId is set. A caller
  // that omits the now-required whyFailedStatus gets no whyFailed at all,
  // not a silent, page-limited guess.
  const status = { ok: true, runs: RUNS, queueEntries: QUEUE, truncated: { runs: false, queueEntries: false } };
  const outcome = buildStandupOutcome({ status, whyFailedRunId: "r2" });
  assert.equal(outcome.whyFailed, null);
});

// ── standup.ts wiring: the dedicated ref=<runId> fetch actually exists ─────
// buildStandupOutcome's whyFailedStatus path (above) is dead unless the tool
// wrapper actually makes the second, targeted fetch and passes its result
// through. Assert the source, the same structural-wiring convention used by
// backlog-triage-skill.test.mjs for its tool files.

test("standup.ts issues a SECOND fetchWorkStatus call with ref: input.whyFailedRunId, and passes the result as whyFailedStatus", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../agent/tools/standup.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    src,
    /ref:\s*input\.whyFailedRunId/,
    "must pass whyFailedRunId as `ref` to a dedicated fetchWorkStatus call (exact, unpaginated resolution)",
  );
  assert.match(
    src,
    /whyFailedStatus/,
    "must thread the dedicated fetch's result into buildStandupOutcome as whyFailedStatus",
  );
});

test("standup.ts and fetch_work_status.ts both bound the console fetch with a 10s AbortSignal timeout (Minor 11)", () => {
  for (const name of ["standup.ts", "fetch_work_status.ts"]) {
    const src = readFileSync(
      fileURLToPath(new URL(`../agent/tools/${name}`, import.meta.url)),
      "utf8",
    );
    assert.match(
      src,
      /AbortSignal\.timeout\(\s*(?:FETCH_TIMEOUT_MS|10_000|10000)\s*\)/,
      `${name} must bound its fetch with AbortSignal.timeout so a wedged console can't hang the turn`,
    );
  }
});
