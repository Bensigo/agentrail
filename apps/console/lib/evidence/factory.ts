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
// recent 200 created for the workspace will under-report (see the task
// report's Concerns section) — acceptable for a first-cut internal adapter,
// not silently swept under the rug.
const CANDIDATE_RUN_FETCH_LIMIT = 200;

const CHANGES_DEFAULT_LIMIT = 50;
const SEARCH_EVENTS_DEFAULT_LIMIT = 200;

const NO_RUNS_IN_WINDOW = "(no runs in window)";
const NO_MATCHING_EVENTS = "(no matching events)";

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
 * The workspace's runs whose `createdAt` falls in `[windowStart, windowEnd]`
 * (inclusive both ends), most-recent-first. `createdAt` — never null, per
 * the `runs` schema — is the window-membership field, not `startedAt`
 * (null for a still-queued run) or `finishedAt` (null until terminal): a
 * "what did the factory do in this span" question should include work
 * queued but not yet started. Bounded by
 * {@link CANDIDATE_RUN_FETCH_LIMIT} — see that constant's own doc-comment.
 */
async function runsInWindow(
  workspaceId: string,
  windowStart: string,
  windowEnd: string
): Promise<WorkspaceRun[]> {
  const { rows } = await getWorkspaceRuns(workspaceId, CANDIDATE_RUN_FETCH_LIMIT);
  return rows
    .filter((r) => inWindow(r.createdAt, windowStart, windowEnd))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
  const candidates = await runsInWindow(workspaceId, q.windowStart, q.windowEnd);
  if (candidates.length === 0) {
    return { ok: true, raw: NO_RUNS_IN_WINDOW };
  }

  // Only needed to resolve issue numbers — fetched after confirming there is
  // at least one candidate run, so a zero-runs window never touches this.
  const { rows: queueRows } = await getWorkspaceQueueEntries(workspaceId, CANDIDATE_RUN_FETCH_LIMIT);
  const queueById = new Map(queueRows.map((entry) => [entry.id, entry]));

  const limited = candidates.slice(0, q.limit ?? CHANGES_DEFAULT_LIMIT);
  const raw = limited.map((r) => renderChangeLine(r, queueById)).join("\n");
  return { ok: true, raw };
}

interface RenderedEvent {
  occurredAt: Date;
  line: string;
}

/** `<iso> run=<id> failure_type=<x> phase=<y> severity=<z> message=<w>` — timestamp + run id + event text, per the pinned format. */
function renderFailureLine(runId: string, f: FailureEventRecord): RenderedEvent {
  const occurredAt = new Date(f.occurred_at);
  const line =
    `${occurredAt.toISOString()} run=${runId} failure_type=${singleLine(f.failure_type)} ` +
    `phase=${singleLine(f.phase)} severity=${singleLine(f.severity)} message=${singleLine(f.message)}`;
  return { occurredAt, line };
}

/** `<iso> run=<id> event_type=<x> phase=<y> severity=<z>` — same shape as {@link renderFailureLine}. */
function renderRunEventLine(runId: string, e: TelemetryEventRecord): RenderedEvent {
  const occurredAt = new Date(e.occurred_at);
  const line =
    `${occurredAt.toISOString()} run=${runId} event_type=${singleLine(e.event_type)} ` +
    `phase=${singleLine(e.phase)} severity=${singleLine(e.severity)}`;
  return { occurredAt, line };
}

async function querySearchEvents(workspaceId: string, q: EvidenceQuery): Promise<AdapterResult> {
  const candidates = await runsInWindow(workspaceId, q.windowStart, q.windowEnd);
  if (candidates.length === 0) {
    return { ok: true, raw: NO_MATCHING_EVENTS };
  }

  const perRun = await Promise.all(
    candidates.map(async (run) => {
      const [failures, events] = await Promise.all([
        getFailuresForRun(workspaceId, run.id),
        getRunEventsByRunId(workspaceId, run.id),
      ]);
      return [
        ...failures.map((f) => renderFailureLine(run.id, f)),
        ...events.map((e) => renderRunEventLine(run.id, e)),
      ];
    })
  );

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
    return { ok: true, raw: NO_MATCHING_EVENTS };
  }

  // Cap keeps the MOST RECENT `limit` lines (the tail of the ascending
  // sort), not the oldest — a debugging investigator asking "what happened
  // near this symptom" is better served by recency than by an arbitrary
  // truncation from the start of the window. Output stays chronological.
  const limit = q.limit ?? SEARCH_EVENTS_DEFAULT_LIMIT;
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
