// Pure, dependency-free helpers for Jace's READ-ONLY standup skill.
//
// The standup reports on the AgentRail factory using ONLY facts that are backed
// by a real Postgres column. Everything here is side-effect-free and
// dependency-injected: the DB access is passed in as an already-fetched row set
// (see agent/lib/standup.db.mjs for the read-only fetch edge), so this module
// never opens a connection, never writes, and is unit-testable without Postgres.
//
// This file lives under agent/lib/, which Eve treats as a recognized lib
// directory: helper .mjs modules here are NOT loaded as tools.
//
// ── Why this file is so strict about "allowed fields" ────────────────────────
// The `runs` table has NO error/reason column (see
// packages/db-postgres/src/schema/runs.ts — status is an enum of
// queued|running|success|failed and that is ALL the outcome signal there is).
// The failure EVENTS themselves live in append-only ClickHouse, not here, and
// there is no failure-summary source wired into the standup for v1. So a standup
// that narrated "why run X failed" would be confabulating. This module makes
// that structurally impossible: every reported figure is derived from an
// enumerated, schema-backed column, and "why did it fail" gets an honest
// no-source answer (see WHY_FAILED_NO_SOURCE / answerWhyFailed).

/**
 * The ONLY `runs` columns a standup is allowed to read/report. Each entry is a
 * real column on the `runs` pgTable (packages/db-postgres/src/schema/runs.ts).
 * Notably absent — because the column does not exist — is any `error`/`reason`/
 * `failureSummary`/`logs` field. AC1's test asserts the standup emits no claim
 * outside this set.
 * @type {readonly string[]}
 */
export const RUNS_ALLOWED_FIELDS = Object.freeze([
  "id",
  "status", // queued | running | success | failed  (the only outcome signal)
  "costUsd",
  "prUrl",
  "title",
  "branch",
  "agent",
  "createdAt",
]);

/**
 * The ONLY `queue_entries` columns a standup is allowed to read/report. Each is
 * a real column on the `queue_entries` pgTable
 * (packages/db-postgres/src/schema/queue_entries.ts). `state` carries the
 * terminal `escalated-to-human` value that the standup reports as an escalation.
 * @type {readonly string[]}
 */
export const QUEUE_ALLOWED_FIELDS = Object.freeze([
  "id",
  "state", // queued|parked|running | green|escalated-to-human|blocked
  "title",
  "externalId",
  "tier",
]);

/** Union of every schema-backed field a standup may touch. AC1 enumerates this. */
export const STANDUP_ALLOWED_FIELDS = Object.freeze([
  ...RUNS_ALLOWED_FIELDS.map((f) => `runs.${f}`),
  ...QUEUE_ALLOWED_FIELDS.map((f) => `queue_entries.${f}`),
]);

/** The `runs.status` enum values (packages/db-postgres/src/schema/runs.ts). */
export const RUN_STATES = Object.freeze([
  "queued",
  "running",
  "success",
  "failed",
]);

/** The `queue_entries.state` terminal value the standup treats as an escalation. */
export const ESCALATED_STATE = "escalated-to-human";

/**
 * The single honest answer to any "why did run X fail" question. There is no
 * failure-detail source in schema (AC2): the standup NEVER invents a reason.
 */
export const WHY_FAILED_NO_SOURCE =
  "No failure-detail source available: the runs table records only a " +
  "status (queued/running/success/failed) — there is no error, reason, or " +
  "log column, and no failure-summary source is wired into the standup for " +
  "v1. I can report what IS known (state, cost, PR link) but I will not " +
  "invent a reason.";

/**
 * Round a dollar figure to cents without floating-point noise.
 * @param {number|undefined|null} n
 * @returns {number}
 */
function toCents(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Build a standup report object from already-fetched, read-only row sets.
 *
 * Every field on the returned object is derived SOLELY from an enumerated,
 * schema-backed column (RUNS_ALLOWED_FIELDS / QUEUE_ALLOWED_FIELDS). There is
 * deliberately no "reason"/"why" field anywhere — that would require a source
 * that does not exist (AC1).
 *
 * @param {object} input
 * @param {Array<{id?: string, status?: string, costUsd?: number, prUrl?: string, title?: string}>} [input.runs]
 *   rows from `runs` (already selected, read-only)
 * @param {Array<{id?: string, state?: string, title?: string, externalId?: string}>} [input.queueEntries]
 *   rows from `queue_entries` (already selected, read-only)
 * @returns {{
 *   runCountsByState: Record<string, number>,
 *   totalRuns: number,
 *   totalCostUsd: number,
 *   prLinks: string[],
 *   escalations: Array<{ id?: string, title?: string, externalId?: string }>,
 *   queueStateCounts: Record<string, number>,
 * }}
 */
export function buildStandup({ runs = [], queueEntries = [] } = {}) {
  const runRows = Array.isArray(runs) ? runs : [];
  const queueRows = Array.isArray(queueEntries) ? queueEntries : [];

  // Run counts by state — seed every enum value so a state with zero runs is
  // reported as 0 rather than being silently absent.
  /** @type {Record<string, number>} */
  const runCountsByState = {};
  for (const s of RUN_STATES) runCountsByState[s] = 0;
  let totalCostUsd = 0;
  /** @type {string[]} */
  const prLinks = [];

  for (const r of runRows) {
    const state = String(r?.status ?? "");
    if (Object.prototype.hasOwnProperty.call(runCountsByState, state)) {
      runCountsByState[state] += 1;
    }
    totalCostUsd += Number(r?.costUsd) || 0;
    const pr = String(r?.prUrl ?? "").trim();
    if (pr) prLinks.push(pr);
  }

  // Queue state counts + the escalations (state === escalated-to-human).
  /** @type {Record<string, number>} */
  const queueStateCounts = {};
  /** @type {Array<{ id?: string, title?: string, externalId?: string }>} */
  const escalations = [];
  for (const q of queueRows) {
    const state = String(q?.state ?? "");
    queueStateCounts[state] = (queueStateCounts[state] || 0) + 1;
    if (state === ESCALATED_STATE) {
      escalations.push({
        id: q?.id,
        title: q?.title,
        externalId: q?.externalId,
      });
    }
  }

  return {
    runCountsByState,
    totalRuns: runRows.length,
    totalCostUsd: toCents(totalCostUsd),
    prLinks,
    escalations,
    queueStateCounts,
  };
}

/**
 * Render the standup object into a plain-text report a human can read. The
 * renderer only ever prints values produced by buildStandup, so it too stays
 * inside the schema-backed field set (AC1).
 *
 * @param {ReturnType<typeof buildStandup>} standup
 * @returns {string}
 */
export function renderStandup(standup) {
  const s = standup ?? buildStandup({});
  const lines = [];
  lines.push("Standup — schema-backed facts only");
  lines.push("");
  lines.push(`Runs: ${s.totalRuns} total`);
  for (const state of RUN_STATES) {
    lines.push(`  ${state}: ${s.runCountsByState[state] ?? 0}`);
  }
  lines.push(`Total cost: $${s.totalCostUsd.toFixed(2)}`);
  lines.push(
    `Open PRs: ${s.prLinks.length}` +
      (s.prLinks.length ? `\n  ${s.prLinks.join("\n  ")}` : ""),
  );
  lines.push(`Escalations (queued to a human): ${s.escalations.length}`);
  for (const e of s.escalations) {
    const label = e.title || e.externalId || e.id || "(unnamed)";
    lines.push(`  - ${label}`);
  }
  const queueStates = Object.keys(s.queueStateCounts).sort();
  if (queueStates.length) {
    lines.push("Queue states:");
    for (const state of queueStates) {
      lines.push(`  ${state}: ${s.queueStateCounts[state]}`);
    }
  }
  return lines.join("\n");
}

/**
 * Answer a "why did run X fail" question HONESTLY. There is no failure-detail
 * source in schema, so this NEVER returns a reason — it returns the fixed
 * no-source explanation plus whatever IS schema-backed for that run (state,
 * cost, PR link). AC2.
 *
 * @param {{ id?: string, status?: string, costUsd?: number, prUrl?: string }} [run]
 *   a single `runs` row (or undefined if not found)
 * @returns {{ hasFailureReason: false, message: string, known: object|null }}
 */
export function answerWhyFailed(run) {
  if (!run) {
    return {
      hasFailureReason: false,
      message: WHY_FAILED_NO_SOURCE,
      known: null,
    };
  }
  // Only schema-backed columns are echoed back — never a fabricated reason.
  const known = {
    id: run.id,
    status: run.status,
    costUsd: toCents(run.costUsd),
    prUrl: String(run.prUrl ?? "").trim() || null,
  };
  return {
    hasFailureReason: false,
    message: WHY_FAILED_NO_SOURCE,
    known,
  };
}
