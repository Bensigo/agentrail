// Pure, dependency-free helpers for Jace's READ-ONLY standup skill.
//
// The standup reports on the AgentRail factory using ONLY facts that are backed
// by a real Postgres column. Everything here is side-effect-free and
// dependency-injected: the row sets are passed in already-fetched (from
// agent/lib/fetch_work_status.core.mjs's workspace-scoped console read — see
// agent/tools/standup.ts's own doc-comment for why that replaced the old
// direct-Postgres edge), so this module never opens a connection, never
// writes, and is unit-testable without Postgres or a live console.
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
 * `opts.truncated` mirrors fetchWorkStatus's `truncated` shape
 * (`{ runs?: boolean, queueEntries?: boolean }`) — the console route caps how
 * many rows it returns, so when either flag is true the collection handed to
 * `standup` is only a PAGE, not the workspace's complete history. This
 * function is the single place that honesty gets threaded into the text: it
 * never prints a truncated collection as if it were complete. When `runs` is
 * truncated, the headline reads "N most recent" instead of "N total" — never
 * a bare total that would silently under-report (a truncated run count also
 * means the total cost / open-PR count summed from it are partial, not the
 * full history). When `queueEntries` is truncated, the "Queue states" section
 * header says so too.
 *
 * @param {ReturnType<typeof buildStandup>} standup
 * @param {{ truncated?: { runs?: boolean, queueEntries?: boolean } }} [opts]
 * @returns {string}
 */
export function renderStandup(standup, opts = {}) {
  const s = standup ?? buildStandup({});
  const runsTruncated = opts?.truncated?.runs === true;
  const queueTruncated = opts?.truncated?.queueEntries === true;
  const lines = [];
  lines.push("Standup — schema-backed facts only");
  lines.push("");
  lines.push(
    runsTruncated
      ? `Runs: ${s.totalRuns} most recent — truncated, not the complete history`
      : `Runs: ${s.totalRuns} total`,
  );
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
    lines.push(
      queueTruncated
        ? "Queue states (most recent — truncated, not the complete history):"
        : "Queue states:",
    );
    for (const state of queueStates) {
      lines.push(`  ${state}: ${s.queueStateCounts[state]}`);
    }
  }
  if (runsTruncated || queueTruncated) {
    const parts = [];
    if (runsTruncated) parts.push("runs");
    if (queueTruncated) parts.push("queue entries");
    lines.push("");
    lines.push(
      `Note: the ${parts.join(" and ")} above reflect only the most recent page ` +
        "returned by the console — there may be more not shown here. Totals " +
        "above are NOT the workspace's complete history.",
    );
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

/**
 * Orchestrate the standup tool's result from an already-fetched work-status
 * snapshot (the shape `fetchWorkStatus` — agent/lib/fetch_work_status.core.mjs
 * — returns, ok or degraded). Pure: no fetch, no env, no session; the tool
 * wrapper (agent/tools/standup.ts) does the one real fetch and hands the
 * result here. This is the same "injected dependency, no module mocking"
 * convention the rest of this app uses for its *.core.mjs modules (see
 * fetch_run_evidence.core.mjs's `transport` seam / instrumentation.core.mjs's
 * header comment) — it is what makes the tool's orchestration logic
 * (degraded passthrough, truncation, whyFailedRunId lookup) unit-testable
 * without mocking `fetchWorkStatus` itself.
 *
 * - A degraded status is returned VERBATIM (same reference) — never turned
 *   into an empty standup, which would read as "nothing is running" when the
 *   truth is "this read failed" (Part 3 of the retirement: an empty report
 *   would lie).
 * - An ok status is folded through buildStandup/renderStandup exactly as
 *   before, with `status.truncated` threaded into renderStandup so a
 *   truncated page is never presented as the complete picture (Part 2).
 * - `whyFailedRunId` is resolved via a SECOND, targeted fetch (Important 4):
 *   the tool wrapper (agent/tools/standup.ts) makes a dedicated
 *   `fetchWorkStatus({ ref: whyFailedRunId })` call — the route's `ref`
 *   mode resolves a run id EXACTLY and unpaginated (see
 *   `findWorkspaceWorkByRef`'s `run-id` branch in
 *   packages/db-postgres/src/queries/work_status.ts), so a failed run older
 *   than the aggregate list's page is still found. (Minor 7: the wrapper
 *   skips the actual round-trip when the run is already in the aggregate
 *   page, but still passes a `whyFailedStatus`-shaped result built from
 *   that row — this function cannot tell the difference, and does not need
 *   to.) That result is passed in here as `whyFailedStatus`, and is now
 *   REQUIRED whenever `whyFailedRunId` is set (Minor 5) — there is no more
 *   "search the aggregate page and hope" fallback; that page-limited search
 *   is exactly what the dedicated lookup above was added to retire, and
 *   leaving both paths alive meant a future second caller could silently
 *   reinherit the bug.
 *   - `whyFailedStatus.ok === true`: look the run up in ITS (unpaginated)
 *     `runs` array.
 *     - Found: answer via `answerWhyFailed` (AC2 — never a fabricated
 *       reason).
 *     - Not found (Important 1): this is a DIFFERENT claim than "no reason
 *       is recorded" — it means the id itself does not resolve to any run
 *       in this workspace. `answerWhyFailed(undefined)`'s
 *       `WHY_FAILED_NO_SOURCE` message asserts the run exists ("the runs
 *       table records only a status … I will not invent a reason"), which
 *       would misrepresent a bad/mistyped run id as a real run with an
 *       unrecorded reason. Report `{ notFound: true, known: null,
 *       message: "…found no such run…" }` instead — a claim about the
 *       LOOKUP, not a claim about a real run's failure detail.
 *   - `whyFailedStatus.ok === false`: the dedicated lookup itself failed
 *     (unreachable, unconfigured, …) — an honest gap in THIS fetch, surfaced
 *     on `whyFailed` as `{ degraded: true, reason, message }` rather than
 *     silently re-interpreted as "no such run" or "no reason recorded".
 *
 * @param {object} args
 * @param {{ ok: boolean, runs?: Array<object>, queueEntries?: Array<object>,
 *           truncated?: { runs?: boolean, queueEntries?: boolean } }} args.status
 *   the fetchWorkStatus result — ok or degraded
 * @param {string} [args.whyFailedRunId]
 * @param {{ ok: boolean, runs?: Array<object>, degraded?: boolean,
 *           reason?: string, note?: string }} [args.whyFailedStatus]
 *   the fetchWorkStatus({ ref: whyFailedRunId }) result — ok or degraded.
 *   REQUIRED whenever `whyFailedRunId` is set (Minor 5) — there is no
 *   fallback that searches `status.runs` instead; a caller that sets
 *   `whyFailedRunId` without this gets no `whyFailed` at all rather than a
 *   page-limited guess.
 * @returns {object} either `status` verbatim (degraded), or
 *   `{ report, standup, whyFailed, failureReasonPolicy, truncated }`
 */
export function buildStandupOutcome({ status, whyFailedRunId, whyFailedStatus } = {}) {
  if (!status || status.ok !== true) return status;

  const standup = buildStandup({
    runs: status.runs,
    queueEntries: status.queueEntries,
  });
  const report = renderStandup(standup, { truncated: status.truncated });

  let whyFailed = null;
  if (whyFailedRunId && whyFailedStatus) {
    if (whyFailedStatus.ok === true) {
      const run = (Array.isArray(whyFailedStatus.runs) ? whyFailedStatus.runs : []).find(
        (r) => r && r.id === whyFailedRunId,
      );
      // Important 1: "no such run" and "no reason recorded" are DIFFERENT
      // claims. answerWhyFailed(undefined) would return WHY_FAILED_NO_SOURCE,
      // which asserts the run exists ("the runs table records only a
      // status … I will not invent a reason") — wrong when the id itself
      // doesn't resolve to anything in this workspace. Keep those shapes
      // distinct instead of collapsing a lookup miss into a reason-shaped
      // answer about a run that was never found.
      whyFailed = run
        ? answerWhyFailed(run)
        : {
            hasFailureReason: false,
            notFound: true,
            known: null,
            message:
              `I looked up run ${whyFailedRunId} in this workspace's work and ` +
              "found no such run — I can't say why it failed, and I won't guess.",
          };
    } else {
      // The dedicated ref=<runId> lookup itself failed (unreachable,
      // unconfigured, ...) — an honest gap in THIS fetch, never
      // downgraded to a fabricated "no such run".
      whyFailed = {
        hasFailureReason: false,
        message: whyFailedStatus.note || WHY_FAILED_NO_SOURCE,
        known: null,
        degraded: true,
        reason: whyFailedStatus.reason,
      };
    }
  }

  return {
    report,
    standup,
    whyFailed,
    // A stable note so the model never fills a failure-reason gap from memory.
    failureReasonPolicy: WHY_FAILED_NO_SOURCE,
    // Raw truncation flags, alongside the note folded into `report` above —
    // a caller inspecting the object directly (not just the rendered text)
    // can still tell a full page from a complete one.
    truncated: status.truncated,
  };
}
