import {
  getWorkspaceRuns,
  getWorkspaceQueueEntries,
  type WorkspaceRun,
  type WorkspaceQueueEntry,
} from "@agentrail/db-postgres";
import {
  getFailuresForRun,
  getRunEventsByRunId,
  type FailureEventRecord,
  type TelemetryEventRecord,
} from "@agentrail/db-clickhouse";
import { registerAdapter } from "./registry";
import type { EvidenceAdapter, EvidenceDegradationReason, EvidenceQuery } from "./types";

/**
 * The `factory` evidence adapter (Task 5, debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
 * follows). The FIRST REAL {@link EvidenceAdapter} — every other provider
 * (Task 6's github, Task 7's railway) reaches an EXTERNAL tool over a
 * per-workspace credential; `factory` answers from this console's OWN store
 * instead — the runs this workspace's own factory produced, and the
 * failure/run events those runs emitted.
 *
 * Its catalog entry (`connector-helpers.ts`'s `CONNECTOR_CATALOG`) is
 * `availability: "internal"`, which makes it unconditionally credentialed
 * for every workspace (see `registry.ts::evidenceCapabilities`'s own
 * doc-comment) — there is no connector row, nothing to connect, and no
 * `connectors.secret` for it ever exists. The route still resolves a
 * `secret` for every provider unconditionally, including this one (see
 * `runner/evidence/route.ts`'s own fan-out loop — it does not special-case
 * `availability: "internal"` when calling `getConnectorSecret`); that
 * resolves to `null` (no row exists to find), and this adapter simply never
 * reads its `secret` parameter — see `query`'s own doc-comment.
 *
 * Building blocks (deliberately reused, not reinvented — this task's Files
 * list is console-only; no new query is added to either package):
 * `getWorkspaceRuns`/`getWorkspaceQueueEntries` (`@agentrail/db-postgres`,
 * the same pair `runner/work-status/route.ts` reads) for `changes`;
 * `getFailuresForRun`/`getRunEventsByRunId` (`@agentrail/db-clickhouse`, the
 * same pair `runner/failure-bundle/route.ts` reads) for `search_events`.
 *
 * Fix round 1 (post-implementation review): (1) ClickHouse timestamp
 * normalization for `search_events` — see {@link parseClickHouseTimestamp}.
 * (2) an honest "may be incomplete" caveat on the zero-match markers when
 * the 200-run fetch horizon doesn't reach `windowStart` — see
 * {@link runsInWindow}. (3) `limit` clamped to ≥ 1 on both verbs. (4) the
 * `search_events` per-run fan-out is chunked to bound concurrent ClickHouse
 * calls.
 */

// `getWorkspaceRuns`'s own default recency page is 50, capped at
// `WORKSPACE_RUNS_MAX_LIMIT` (200, `queries/work_status.ts`). This adapter
// pages through the same 200-row ceiling as its OWN candidate set before
// filtering to the requested window — a plain local number, not an import
// of that constant, so this module stays decoupled from
// `@agentrail/db-postgres`'s exported shape (this file's own tests mock
// that package down to two named functions; a route consumer mocks it down
// to a different six — see `factory.test.ts` / `runner/evidence/route.test.ts`).
// KNOWN v1 LIMIT: a window whose matching runs are all older than the most
// recent 200 created for the workspace will under-report. Unlike this
// file's pre-review draft, this is no longer silent: see
// {@link runsInWindow}'s `horizonUncertain` and the two `*EmptyMarker`
// helpers below — a zero-match result says so when it might be incomplete.
// The proper fix is a real `createdAt`-ranged Postgres query in
// `work_status.ts`, out of scope for this task's console-only file list.
const CANDIDATE_RUN_FETCH_LIMIT = 200;

const CHANGES_DEFAULT_LIMIT = 50;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;

// Fold-in B: bounds how many runs' worth of ClickHouse calls (2 per run —
// getFailuresForRun + getRunEventsByRunId) are ever in flight at once for
// `search_events`. Without this, a window with up to CANDIDATE_RUN_FETCH_LIMIT
// (200) runs would fire up to 400 concurrent requests in one burst.
const SEARCH_EVENTS_RUN_BATCH_SIZE = 10;

const NO_RUNS_IN_WINDOW = "(no runs in window)";
const NO_MATCHING_EVENTS = "(no matching events)";
// Fix 2: appended to a zero-match marker when the run fetch hit
// CANDIDATE_RUN_FETCH_LIMIT and even the OLDEST run it saw is still newer
// than `windowStart` — i.e., there may be workspace history further back
// that this adapter never looked at, so "found nothing" is not a strong
// claim. See `runsInWindow`'s own doc-comment.
const HORIZON_CAVEAT =
  " — note: only the 200 most recent runs were searched and the window extends earlier";

type AdapterResult = { ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason };

/**
 * Mirrors `runner/evidence/route.ts`'s own `isValidIsoDate` exactly.
 * Duplicated rather than imported (the route does not export it, and this
 * adapter must degrade `bad_request` correctly even when called directly —
 * as its own tests do — never assuming the route already validated the
 * window first; pinned decision: "DO validate inputs: unparseable window ->
 * bad_request").
 */
function isValidIsoDate(value: string): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** Collapse embedded newlines so a free-text field (a failure `message`, a
 * PR url, …) can never split a rendered "one record per line" line in two. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function inWindow(at: Date, windowStart: string, windowEnd: string): boolean {
  const t = at.getTime();
  return t >= new Date(windowStart).getTime() && t <= new Date(windowEnd).getTime();
}

/**
 * Fix round 1, FIX 1: normalizes a raw ClickHouse `DateTime64` value into a
 * `Date`. `FailureEventRecord`/`TelemetryEventRecord` (`@agentrail/db-
 * clickhouse`) both TYPE `occurred_at` as `Date`, but neither
 * `getFailuresForRun` nor `getRunEventsByRunId` actually normalizes it
 * before returning (`result.json<T>()` passes ClickHouse's raw JSON straight
 * through) — at runtime, ClickHouse's HTTP `JSONEachRow` interface returns a
 * `DateTime64` column as a raw, timezone-less string, e.g.
 * `"2026-07-29 00:32:00.000"`, never a real `Date` instance and never
 * ISO-8601 (no `T`, no `Z`). Handing that straight to `new Date(...)` gets
 * parsed as LOCAL time by the JS engine — a real, reproducible bug (a
 * 4-hour skew under `TZ=America/New_York`, confirmed by code review, and
 * reproducible in this repo's own sandbox default TZ of Asia/Dubai).
 *
 * CANONICAL implementation: `parseClickHouseTimestamp` in
 * `packages/db-clickhouse/src/queries.ts` (~line 1387, used internally by
 * `getRunTelemetryHealth`/`listCostAnomalies`/etc. before THEY return a
 * timestamp). Not exported from that package, so duplicated here rather
 * than imported — keep in sync if the canonical one changes. Same shape:
 * a bare `Date`/already-ISO/already-offset string passes through unchanged;
 * otherwise the ClickHouse `"YYYY-MM-DD HH:mm:ss.SSS"` shape gets its space
 * turned into `T` and a `Z` appended, matching `formatClickHouseDateTime`'s
 * exact inverse (that file's write-side proof that these are stored/read as
 * UTC, not local time).
 */
function parseClickHouseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const raw = value.trim();
  const normalized =
    raw.includes("T") || /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Fold-in B: split `items` into fixed-size, order-preserving batches. */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

interface RunsInWindowResult {
  /** Window-filtered, most-recent-first. */
  candidates: WorkspaceRun[];
  /**
   * Fix 2: true iff the underlying fetch hit {@link CANDIDATE_RUN_FETCH_LIMIT}
   * (`getWorkspaceRuns`' own `truncated` — there is more workspace history
   * this adapter did not fetch) AND the oldest run it DID fetch is still
   * newer than `windowStart` — i.e., the fetch horizon never reached back
   * far enough to rule out matches earlier in the window. Computed from the
   * FULL fetched set (before window-filtering), since the whole point is to
   * answer "did we even look at everything up to windowStart" independent
   * of how many of those rows happened to land inside the window.
   */
  horizonUncertain: boolean;
}

/**
 * The workspace's runs whose `createdAt` falls in `[windowStart, windowEnd]`
 * (inclusive both ends), most-recent-first. `createdAt` — never null, per
 * the `runs` schema — is the window-membership field, not `startedAt`
 * (null for a still-queued run) or `finishedAt` (null until terminal): a
 * "what did the factory do in this span" question should include work
 * queued but not yet started. Bounded by
 * {@link CANDIDATE_RUN_FETCH_LIMIT} — see {@link RunsInWindowResult.horizonUncertain}
 * for how that bound is surfaced honestly rather than silently.
 */
async function runsInWindow(
  workspaceId: string,
  windowStart: string,
  windowEnd: string
): Promise<RunsInWindowResult> {
  const { rows, truncated } = await getWorkspaceRuns(workspaceId, CANDIDATE_RUN_FETCH_LIMIT);

  const candidates = rows
    .filter((r) => inWindow(r.createdAt, windowStart, windowEnd))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  let horizonUncertain = false;
  if (truncated && rows.length > 0) {
    const oldestFetchedAt = rows.reduce(
      (min, r) => (r.createdAt.getTime() < min.getTime() ? r.createdAt : min),
      rows[0].createdAt
    );
    horizonUncertain = oldestFetchedAt.getTime() > new Date(windowStart).getTime();
  }

  return { candidates, horizonUncertain };
}

/** Fix 2: the `changes` verb's zero-match marker, honest about an uncertain fetch horizon. */
function changesEmptyMarker(horizonUncertain: boolean): string {
  return horizonUncertain ? `(no runs found in window${HORIZON_CAVEAT})` : NO_RUNS_IN_WINDOW;
}

/** Fix 2: the `search_events` verb's zero-match marker — same caveat, its own base phrase. */
function searchEventsEmptyMarker(horizonUncertain: boolean): string {
  return horizonUncertain ? `(no matching events${HORIZON_CAVEAT})` : NO_MATCHING_EVENTS;
}

/**
 * `queue_entries.external_id` is `owner/repo#N` for a GitHub-sourced entry
 * (see `queries/work_status.ts::findWorkspaceWorkByRef`'s own doc-comment) —
 * this pulls the trailing issue number back out for the `issue=#<n>` field.
 * A legacy CLI-sourced entry's `external_id` carries no `#` at all (same
 * doc-comment), so this returns `null` for it, same as a dangling/absent
 * queue entry — the render layer collapses every "can't resolve" case to
 * the same honest `issue=-`.
 */
function issueNumberFromExternalId(externalId: string): string | null {
  const match = /#(\d+)$/.exec(externalId);
  return match ? match[1] : null;
}

/** `run <id> issue=<#n|-> state=<state> started=<iso|-> finished=<iso|-> pr=<url|->` — pinned field order (task brief). */
function renderChangeLine(run: WorkspaceRun, queueById: Map<string, WorkspaceQueueEntry>): string {
  const queueEntry = run.queueEntryId ? queueById.get(run.queueEntryId) : undefined;
  const issueNumber = queueEntry ? issueNumberFromExternalId(queueEntry.externalId) : null;
  const issue = issueNumber ? `#${issueNumber}` : "-";
  const started = run.startedAt ? run.startedAt.toISOString() : "-";
  const finished = run.finishedAt ? run.finishedAt.toISOString() : "-";
  const pr = run.prUrl ? singleLine(run.prUrl) : "-";
  return `run ${run.id} issue=${issue} state=${run.status} started=${started} finished=${finished} pr=${pr}`;
}

async function queryChanges(workspaceId: string, q: EvidenceQuery): Promise<AdapterResult> {
  const { candidates, horizonUncertain } = await runsInWindow(workspaceId, q.windowStart, q.windowEnd);
  if (candidates.length === 0) {
    return { ok: true, raw: changesEmptyMarker(horizonUncertain) };
  }

  // Only needed to resolve issue numbers — fetched after confirming there is
  // at least one candidate run, so a zero-runs window never touches this.
  const { rows: queueRows } = await getWorkspaceQueueEntries(workspaceId, CANDIDATE_RUN_FETCH_LIMIT);
  const queueById = new Map(queueRows.map((entry) => [entry.id, entry]));

  // Fold-in A: floor-clamped so limit:0 (or negative) can't slice candidates
  // down to zero rows and return a bare "" that bypasses the honest-empty
  // marker above — candidates is already known non-empty at this point, so
  // the output must carry at least one line.
  const limit = Math.max(1, q.limit ?? CHANGES_DEFAULT_LIMIT);
  const limited = candidates.slice(0, limit);
  const raw = limited.map((r) => renderChangeLine(r, queueById)).join("\n");
  return { ok: true, raw };
}

interface RenderedEvent {
  occurredAt: Date;
  line: string;
}

/** `<iso> run=<id> failure_type=<x> phase=<y> severity=<z> message=<w>` — timestamp + run id + event text, per the pinned format.
 * Returns `null` (filtered out by the caller) when `occurred_at` fails to
 * parse at all — see {@link parseClickHouseTimestamp}; not expected in
 * practice (`occurred_at` is a NOT NULL ClickHouse column) but this must
 * never throw on a malformed row. */
function renderFailureLine(runId: string, f: FailureEventRecord): RenderedEvent | null {
  const occurredAt = parseClickHouseTimestamp(f.occurred_at);
  if (!occurredAt) return null;
  const line =
    `${occurredAt.toISOString()} run=${runId} failure_type=${singleLine(f.failure_type)} ` +
    `phase=${singleLine(f.phase)} severity=${singleLine(f.severity)} message=${singleLine(f.message)}`;
  return { occurredAt, line };
}

/** `<iso> run=<id> event_type=<x> phase=<y> severity=<z>` — same shape as {@link renderFailureLine}, same `null`-on-unparseable contract. */
function renderRunEventLine(runId: string, e: TelemetryEventRecord): RenderedEvent | null {
  const occurredAt = parseClickHouseTimestamp(e.occurred_at);
  if (!occurredAt) return null;
  const line =
    `${occurredAt.toISOString()} run=${runId} event_type=${singleLine(e.event_type)} ` +
    `phase=${singleLine(e.phase)} severity=${singleLine(e.severity)}`;
  return { occurredAt, line };
}

async function querySearchEvents(workspaceId: string, q: EvidenceQuery): Promise<AdapterResult> {
  const { candidates, horizonUncertain } = await runsInWindow(workspaceId, q.windowStart, q.windowEnd);
  if (candidates.length === 0) {
    return { ok: true, raw: searchEventsEmptyMarker(horizonUncertain) };
  }

  // Fold-in B: chunked, sequential batches (Promise.all WITHIN a batch) —
  // see SEARCH_EVENTS_RUN_BATCH_SIZE's own doc-comment for why.
  const perRun: RenderedEvent[][] = [];
  for (const batch of chunk(candidates, SEARCH_EVENTS_RUN_BATCH_SIZE)) {
    const batchResults = await Promise.all(
      batch.map(async (run) => {
        const [failures, events] = await Promise.all([
          getFailuresForRun(workspaceId, run.id),
          getRunEventsByRunId(workspaceId, run.id),
        ]);
        return [
          ...failures.map((f) => renderFailureLine(run.id, f)),
          ...events.map((e) => renderRunEventLine(run.id, e)),
        ].filter((e): e is RenderedEvent => e !== null);
      })
    );
    perRun.push(...batchResults);
  }

  let rendered = perRun.flat();

  // Substring match against the SAME text the caller receives — never a
  // hidden field the rendered line doesn't show (transparency: if a line
  // matched, the reason is visible in that line).
  if (q.query) {
    const needle = q.query.toLowerCase();
    rendered = rendered.filter((e) => e.line.toLowerCase().includes(needle));
  }

  // Chronological (ascending) — "timestamp + run id + event text, chronological" (pinned).
  rendered.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  if (rendered.length === 0) {
    return { ok: true, raw: searchEventsEmptyMarker(horizonUncertain) };
  }

  // Fold-in A: floor-clamped — see queryChanges' identical comment.
  // Cap keeps the MOST RECENT `limit` lines (the tail of the ascending
  // sort), not the oldest — a debugging investigator asking "what happened
  // near this symptom" is better served by recency than by an arbitrary
  // truncation from the start of the window. Output stays chronological.
  const limit = Math.max(1, q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT);
  const limited = rendered.length > limit ? rendered.slice(rendered.length - limit) : rendered;

  return { ok: true, raw: limited.map((e) => e.line).join("\n") };
}

export const factoryAdapter: EvidenceAdapter = {
  provider: "factory",
  verbs: ["changes", "search_events"],
  /**
   * `secret` is accepted (the {@link EvidenceAdapter} contract requires the
   * parameter) but never read — see this module's own doc-comment for why
   * it is always `null` in practice, and why that would not matter even if
   * it weren't.
   */
  async query(workspaceId, q, _secret): Promise<AdapterResult> {
    if (!isValidIsoDate(q.windowStart) || !isValidIsoDate(q.windowEnd)) {
      return { ok: false, reason: "bad_request" };
    }
    switch (q.verb) {
      case "changes":
        return queryChanges(workspaceId, q);
      case "search_events":
        return querySearchEvents(workspaceId, q);
      default:
        // This adapter declares only [changes, search_events] — the route
        // never asks it for a verb it didn't declare (providers are looked
        // up per-verb via evidenceCapabilities), but a direct caller (this
        // module's own tests included) is not bound by that, so this stays
        // defensive rather than throwing.
        return { ok: false, reason: "bad_request" };
    }
  },
};

registerAdapter(factoryAdapter);
