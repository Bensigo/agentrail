import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db.js";
import { runs } from "../schema/runs.js";
import { queueEntries } from "../schema/queue_entries.js";

/**
 * Task 5 (console "how's that going" work-status feature, Task 6's read
 * route). These are the workspace-scoped reads over `runs` and
 * `queue_entries` that back it — every function here carries
 * `eq(*.workspaceId, workspaceId)` on every query and there is deliberately
 * NO unscoped variant, because the tool this replaces read every workspace's
 * rows with no WHERE clause at all. This module is the tenancy boundary for
 * work-status: adding a new read here without the workspace predicate is the
 * one mistake that must never happen.
 */

/** Default page size for {@link getWorkspaceRuns}. */
export const WORKSPACE_RUNS_DEFAULT_LIMIT = 50;

/** Default page size for {@link getWorkspaceQueueEntries}. */
export const WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT = 50;

/** Non-terminal run statuses — "work happening right now". */
const IN_FLIGHT_RUN_STATUSES: Array<"queued" | "running"> = ["queued", "running"];

/**
 * UUID validation pattern (8-4-4-4-12 hex, case-insensitive). Used in
 * {@link findWorkspaceWorkByRef} to guard against Postgres "invalid input
 * syntax for type uuid" errors when users pass non-UUID refs (e.g. issue
 * numbers like "1468"). This is not cosmetic validation — skipping a
 * non-UUID ref's run-by-id branch prevents the Postgres type error that
 * would otherwise cause a 500 on the single most common input.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Matches an explicit PR reference: "pull/<digits>" at the end of the
 * string, optionally preceded by a path (`owner/repo/pull/1470`, a full
 * `https://github.com/owner/repo/pull/1470` URL) and optionally followed by
 * a trailing slash. Deliberately anchored at the END (`$`) so it can only
 * ever match a `pull/N` suffix, never an arbitrary substring.
 */
const PR_REF_PATTERN = /(?:^|\/)pull\/(\d+)\/?$/i;

/** Longest `ref` this module will attempt to resolve (Minor 8). Anything
 * longer is treated as `"unrecognised"` with zero DB round-trips — refs this
 * long can only ever be user error or abuse, never a real run id, issue
 * number, `owner/repo#N`, or PR link. */
const REF_MAX_LENGTH = 200;

/**
 * How a `ref` string was classified, derived PURELY from the string itself
 * (no DB lookups) — see {@link findWorkspaceWorkByRef}'s own doc-comment for
 * why this must never depend on what a query found.
 */
export type ResolvedRefKind =
  | "run-id"
  | "issue-ref"
  | "qualified-ref"
  | "pr-number"
  | "unrecognised";

export interface WorkspaceRun {
  id: string;
  title: string | null;
  status: string;
  phase: string | null;
  branch: string;
  agent: string;
  prUrl: string | null;
  costUsd: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  /** Not-null in the schema (`runs.repository_id`). Which repo, in a
   * multi-repo workspace, this run belongs to. */
  repositoryId: string;
  /** Nullable — null for a run never tied to a durable queue entry (legacy
   * rows / non-issue-driven runs). Joins back to `queue_entries.id`; see
   * {@link findWorkspaceWorkByRef}'s Critical-2 fix for why this must be
   * the join key instead of assuming `runs.id === queueEntries.id`. */
  queueEntryId: string | null;
  /** Nullable in the schema — never backfilled for rows written before the
   * column existed. */
  updatedAt: Date | null;
  /** Nullable — null for a run whose runner never pinged liveness (older /
   * self-hosted runners). Paired with `updatedAt`, this is what
   * `reconcileStaleRuns` keys reclaim on; a consumer of this route needs the
   * same signal to tell "running" from "wedged". */
  lastLivenessAt: Date | null;
}

export interface WorkspaceQueueEntry {
  id: string;
  externalId: string;
  title: string;
  state: string;
  tier: number;
  kind: string;
  createdAt: Date;
  updatedAt: Date;
  /** Nullable — null when not parked, and for a legacy/reasonless row. The
   * schema-backed answer to "why is this waiting" (issue #1239). */
  parkReason: string | null;
  /** Not-null in the schema (jsonb, `.notNull().default([])`) — issue
   * numbers this entry is blocked by. Empty array, never null, when
   * unblocked. */
  blockedBy: number[];
  /** Not-null in the schema (`integer().notNull().default(5)`). */
  remainingBudget: number;
  /** Nullable — null until an alignment brief prices this entry (true for
   * every kind='onboard' row, forever). */
  estimatedBudgetUsd: number | null;
}

/** {@link getWorkspaceRuns}'s result: the page itself, plus whether that
 * page was truncated (page row count === the applied limit) — the caller
 * needs this to avoid silently under-reporting as if the page were
 * complete (Important 3). `rows` may exceed `limit` in length: in-flight
 * (`queued`/`running`) runs are unconditionally unioned in regardless of
 * whether they fit the recency page (Important 4), so `truncated` reflects
 * the PAGE's completeness, not `rows.length`. */
export interface WorkspaceRunsResult {
  rows: WorkspaceRun[];
  truncated: boolean;
}

/** {@link getWorkspaceQueueEntries}'s result — see {@link WorkspaceRunsResult}. */
export interface WorkspaceQueueEntriesResult {
  rows: WorkspaceQueueEntry[];
  truncated: boolean;
}

export interface WorkspaceWorkByRef {
  runs: WorkspaceRun[];
  queueEntries: WorkspaceQueueEntry[];
  /** How `ref` was classified — see {@link ResolvedRefKind}. Lets the caller
   * (Jace) distinguish "I looked and found nothing" from "that ref wasn't a
   * shape I resolve, I never looked" (Minor 7). */
  resolvedAs: ResolvedRefKind;
}

const workspaceRunColumns = {
  id: runs.id,
  title: runs.title,
  status: runs.status,
  phase: runs.phase,
  branch: runs.branch,
  agent: runs.agent,
  prUrl: runs.prUrl,
  costUsd: runs.costUsd,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  createdAt: runs.createdAt,
  repositoryId: runs.repositoryId,
  queueEntryId: runs.queueEntryId,
  updatedAt: runs.updatedAt,
  lastLivenessAt: runs.lastLivenessAt,
};

const workspaceQueueEntryColumns = {
  id: queueEntries.id,
  externalId: queueEntries.externalId,
  title: queueEntries.title,
  state: queueEntries.state,
  tier: queueEntries.tier,
  kind: queueEntries.kind,
  createdAt: queueEntries.createdAt,
  updatedAt: queueEntries.updatedAt,
  parkReason: queueEntries.parkReason,
  blockedBy: queueEntries.blockedBy,
  remainingBudget: queueEntries.remainingBudget,
  estimatedBudgetUsd: queueEntries.estimatedBudgetUsd,
};

/**
 * Runs for `workspaceId`, newest-first (`createdAt` DESC), capped at
 * `limit` (default 50) — PLUS every in-flight (`queued`/`running`) run for
 * the workspace, unconditionally unioned in and deduped by id (Important 4:
 * `createdAt` is stamped once at claim and never bumped on retry, so a
 * long-running run can be pushed off a recency page by 50 newer rows —
 * "what's running right now" must never come back empty just because the
 * run is old). The merged set is re-sorted `createdAt` DESC for a stable
 * order. Always scoped by `eq(runs.workspaceId, workspaceId)` — see this
 * file's own doc-comment for why there is no unscoped variant.
 *
 * `truncated` reflects the recency PAGE only (page row count === `limit`),
 * not `rows.length` — the in-flight union can make `rows` longer than
 * `limit` without the page itself being incomplete.
 */
export async function getWorkspaceRuns(
  workspaceId: string,
  limit: number = WORKSPACE_RUNS_DEFAULT_LIMIT
): Promise<WorkspaceRunsResult> {
  const [pageRows, inFlightRows] = await Promise.all([
    db
      .select(workspaceRunColumns)
      .from(runs)
      .where(eq(runs.workspaceId, workspaceId))
      .orderBy(desc(runs.createdAt))
      .limit(limit),
    db
      .select(workspaceRunColumns)
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          inArray(runs.status, IN_FLIGHT_RUN_STATUSES)
        )
      ),
  ]);

  const merged = new Map<string, WorkspaceRun>();
  for (const r of pageRows as WorkspaceRun[]) merged.set(r.id, r);
  for (const r of inFlightRows as WorkspaceRun[]) merged.set(r.id, r);

  const rows = [...merged.values()].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );

  return { rows, truncated: pageRows.length === limit };
}

/**
 * Queue entries for `workspaceId`, most-recently-updated-first (`updatedAt`
 * DESC), capped at `limit` (default 50). Always scoped by
 * `eq(queueEntries.workspaceId, workspaceId)` — see this file's own
 * doc-comment for why there is no unscoped variant.
 *
 * NOTE (Important 5 follow-up): this overlaps `runner.ts`'s
 * `listQueueEntries` (active-only filtering, different column set). Left
 * separate deliberately in this pass — `listQueueEntries`'s filter
 * semantics haven't been reviewed against work-status's requirements, so
 * swapping to it is a follow-up, not part of this fix.
 */
export async function getWorkspaceQueueEntries(
  workspaceId: string,
  limit: number = WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT
): Promise<WorkspaceQueueEntriesResult> {
  const rows = await db
    .select(workspaceQueueEntryColumns)
    .from(queueEntries)
    .where(eq(queueEntries.workspaceId, workspaceId))
    .orderBy(desc(queueEntries.updatedAt))
    .limit(limit);

  return { rows: rows as WorkspaceQueueEntry[], truncated: rows.length === limit };
}

/**
 * Classify a `ref` string PURELY from its shape — no DB access. Exported
 * indirectly via {@link WorkspaceWorkByRef.resolvedAs}; kept as a pure
 * function so classification never depends on (and therefore never leaks)
 * whether anything actually matched.
 *
 * Shape rules, checked in order:
 *  1. UUID-shaped (after stripping a single leading `#`) -> `"run-id"`.
 *  2. Ends in `pull/<digits>` (optionally preceded by a path, optionally
 *     followed by `/`) — an explicit PR link or `pull/N` -> `"pr-number"`.
 *  3. All digits -> `"issue-ref"`. Ambiguous between "issue number" and "PR
 *     number" on its own (both are just a bare number to a human), so the
 *     caller resolves BOTH kinds of match for this shape; see the Minor-7
 *     spec this implements.
 *  4. Contains `/` or `#` -> `"qualified-ref"` (a fully-qualified
 *     `owner/repo#N`).
 *  5. Anything else, or longer than {@link REF_MAX_LENGTH} -> `"unrecognised"`.
 */
function classifyRef(ref: string): { resolvedAs: ResolvedRefKind; stripped: string; prNumber: string | null } {
  if (ref.length === 0 || ref.length > REF_MAX_LENGTH) {
    return { resolvedAs: "unrecognised", stripped: ref, prNumber: null };
  }

  // Minor 8: strip a single leading '#' (e.g. "#1468" -> "1468") before
  // matching, so a caller pasting the GitHub-style "#1468" shorthand still
  // resolves.
  const stripped = ref.startsWith("#") ? ref.slice(1) : ref;

  if (UUID_PATTERN.test(stripped)) {
    return { resolvedAs: "run-id", stripped, prNumber: null };
  }

  const prMatch = PR_REF_PATTERN.exec(stripped);
  if (prMatch) {
    return { resolvedAs: "pr-number", stripped, prNumber: prMatch[1] };
  }

  if (/^\d+$/.test(stripped)) {
    return { resolvedAs: "issue-ref", stripped, prNumber: null };
  }

  if (stripped.includes("/") || stripped.includes("#")) {
    return { resolvedAs: "qualified-ref", stripped, prNumber: null };
  }

  return { resolvedAs: "unrecognised", stripped, prNumber: null };
}

/**
 * Resolve a free-text `ref` (a run id, a GitHub issue number, a fully
 * qualified `owner/repo#N`, or a PR number/link) against `workspaceId`'s own
 * work only.
 *
 * Every branch conjuncts the workspace predicate with the ref match — a ref
 * that belongs to another workspace, or does not exist at all, resolves to
 * the SAME empty result (`{ runs: [], queueEntries: [], resolvedAs }`). This
 * is a deliberate tenant-isolation property, not an accident: existence must
 * never leak across workspaces, so this function performs no unscoped
 * lookup anywhere, at any point, to distinguish "wrong tenant" from
 * "doesn't exist".
 *
 * Matching, by shape (see {@link classifyRef}):
 *  - `"run-id"` (UUID-shaped): `eq(runs.id, ref)`, workspace-scoped. Only
 *    attempted for UUID-shaped refs — a non-UUID ref would otherwise trip
 *    Postgres's "invalid input syntax for type uuid" and 500.
 *  - `"issue-ref"` (bare digits, e.g. "1468"): stored `queue_entries`
 *    external ids are `owner/repo#N` (see `github_intake.ts`'s
 *    `enqueueGithubIssue`), so a bare number can only ever match on a `#N`
 *    SUFFIX: `queueEntries.externalId LIKE '%#<digits>'`. The leading `%` is
 *    the ONLY wildcard — anchored on the literal `#` and the end of the
 *    string, so `"#10"` can never match an entry ending `…#101` or `…#1010`.
 *    This mirrors `runner.ts`'s `latestRunForIssue`, which solved the exact
 *    same anchoring problem first. Bare digits are ALSO ambiguous with a PR
 *    number (both are just "a number" to a human), so this shape resolves
 *    BOTH the issue-ref match AND the `"pr-number"` match below, unioned —
 *    `resolvedAs` stays `"issue-ref"` for this shape either way.
 *  - `"qualified-ref"` (contains `/` or `#`, e.g. "Bensigo/agentrail#1468"):
 *    exact equality against `queueEntries.externalId` — the caller supplied
 *    the fully-qualified form the column actually stores.
 *  - `"pr-number"` (explicit `pull/<digits>` or a full PR URL):
 *    `runs.prUrl LIKE '%/pull/<digits>'`, workspace-scoped — `runs.prUrl`
 *    looks like `https://github.com/owner/repo/pull/1470`, so this is a
 *    suffix match for the same anchoring reason as the issue-ref branch.
 *
 * Critical-2 fix: a matched queue entry alone cannot answer "did it land? /
 * what's the PR?" — `prUrl` and `costUsd` live on `runs`, not
 * `queue_entries`. So once queue entries match (issue-ref or qualified-ref),
 * a SECOND workspace-scoped query fetches
 * `runs WHERE workspace_id = $ws AND queue_entry_id IN (<matched ids>)`,
 * joined through `queue_entry_id` explicitly — NOT by assuming
 * `runs.id === queueEntries.id`. That equality holds today only because
 * `claimQueueEntry` (`runner.ts`) happens to insert both from the same
 * value; it is an undocumented coincidence, not a contract, so this
 * function never relies on it. All matched runs (run-id branch + the
 * queue-entry join + the pr-number branch) are deduped by run id into one
 * list.
 */
export async function findWorkspaceWorkByRef(
  workspaceId: string,
  ref: string
): Promise<WorkspaceWorkByRef> {
  const { resolvedAs, stripped, prNumber } = classifyRef(ref);

  if (resolvedAs === "unrecognised") {
    return { runs: [], queueEntries: [], resolvedAs };
  }

  const runByIdPromise =
    resolvedAs === "run-id"
      ? db
          .select(workspaceRunColumns)
          .from(runs)
          .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, stripped)))
          .limit(1)
      : Promise.resolve([] as WorkspaceRun[]);

  let queueCondition: SQL | undefined;
  if (resolvedAs === "issue-ref") {
    // Leading '%' is the only wildcard — anchored on '#' and the string end.
    queueCondition = sql`${queueEntries.externalId} LIKE ${`%#${stripped}`}`;
  } else if (resolvedAs === "qualified-ref") {
    queueCondition = eq(queueEntries.externalId, stripped);
  }

  const queueEntryPromise = queueCondition
    ? db
        .select(workspaceQueueEntryColumns)
        .from(queueEntries)
        .where(and(eq(queueEntries.workspaceId, workspaceId), queueCondition))
    : Promise.resolve([] as WorkspaceQueueEntry[]);

  const [runByIdRows, queueRows] = await Promise.all([runByIdPromise, queueEntryPromise]);

  // Critical 2: pull the runs that belong to the matched queue entries,
  // joined through queue_entry_id (never through id equality).
  const joinedRunRows =
    queueRows.length > 0
      ? ((await db
          .select(workspaceRunColumns)
          .from(runs)
          .where(
            and(
              eq(runs.workspaceId, workspaceId),
              inArray(
                runs.queueEntryId,
                queueRows.map((q) => q.id)
              )
            )
          )) as WorkspaceRun[])
      : [];

  let prRunRows: WorkspaceRun[] = [];
  if (resolvedAs === "pr-number" || resolvedAs === "issue-ref") {
    const number = prNumber ?? stripped;
    prRunRows = (await db
      .select(workspaceRunColumns)
      .from(runs)
      .where(
        and(eq(runs.workspaceId, workspaceId), sql`${runs.prUrl} LIKE ${`%/pull/${number}`}`)
      )) as WorkspaceRun[];
  }

  const runMap = new Map<string, WorkspaceRun>();
  for (const r of [
    ...(runByIdRows as WorkspaceRun[]),
    ...joinedRunRows,
    ...prRunRows,
  ]) {
    runMap.set(r.id, r);
  }

  return {
    runs: [...runMap.values()],
    queueEntries: queueRows as WorkspaceQueueEntry[],
    resolvedAs,
  };
}
