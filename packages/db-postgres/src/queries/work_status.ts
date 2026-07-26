import { and, desc, eq } from "drizzle-orm";
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

/**
 * UUID validation pattern (8-4-4-4-12 hex, case-insensitive). Used in
 * {@link findWorkspaceWorkByRef} to guard against Postgres "invalid input
 * syntax for type uuid" errors when users pass non-UUID refs (e.g. issue
 * numbers like "1468"). This is not cosmetic validation — skipping a
 * non-UUID ref's run-by-id branch prevents the Postgres type error that
 * would otherwise cause a 500 on the single most common input.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}

export interface WorkspaceWorkByRef {
  runs: WorkspaceRun[];
  queueEntries: WorkspaceQueueEntry[];
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
};

/**
 * Runs for `workspaceId`, newest-first (`createdAt` DESC), capped at
 * `limit` (default 50). Always scoped by `eq(runs.workspaceId, workspaceId)`
 * — see this file's own doc-comment for why there is no unscoped variant.
 */
export async function getWorkspaceRuns(
  workspaceId: string,
  limit: number = WORKSPACE_RUNS_DEFAULT_LIMIT
): Promise<WorkspaceRun[]> {
  const rows = await db
    .select(workspaceRunColumns)
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows as WorkspaceRun[];
}

/**
 * Queue entries for `workspaceId`, most-recently-updated-first (`updatedAt`
 * DESC), capped at `limit` (default 50). Always scoped by
 * `eq(queueEntries.workspaceId, workspaceId)` — see this file's own
 * doc-comment for why there is no unscoped variant.
 */
export async function getWorkspaceQueueEntries(
  workspaceId: string,
  limit: number = WORKSPACE_QUEUE_ENTRIES_DEFAULT_LIMIT
): Promise<WorkspaceQueueEntry[]> {
  const rows = await db
    .select(workspaceQueueEntryColumns)
    .from(queueEntries)
    .where(eq(queueEntries.workspaceId, workspaceId))
    .orderBy(desc(queueEntries.updatedAt))
    .limit(limit);
  return rows as WorkspaceQueueEntry[];
}

/**
 * Resolve a free-text `ref` (a run id or a queue entry's `externalId`, e.g.
 * a GitHub issue number like "1468") against `workspaceId`'s own work only.
 *
 * Both branches conjunct the workspace predicate with the ref match — a ref
 * that belongs to another workspace, or does not exist at all, resolves to
 * the SAME empty result (`{ runs: [], queueEntries: [] }`). This is a
 * deliberate tenant-isolation property, not an accident: existence must
 * never leak across workspaces, so this function performs no unscoped
 * lookup anywhere, at any point, to distinguish "wrong tenant" from
 * "doesn't exist".
 *
 * Only attempts the run-by-id lookup if `ref` is UUID-shaped; non-UUID refs
 * skip that branch entirely to avoid Postgres "invalid input syntax for type
 * uuid" errors on user-supplied refs.
 */
export async function findWorkspaceWorkByRef(
  workspaceId: string,
  ref: string
): Promise<WorkspaceWorkByRef> {
  const isUuidShaped = UUID_PATTERN.test(ref);

  const runPromise = isUuidShaped
    ? db
        .select(workspaceRunColumns)
        .from(runs)
        .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, ref)))
        .limit(1)
    : Promise.resolve([] as WorkspaceRun[]);

  const queuePromise = db
    .select(workspaceQueueEntryColumns)
    .from(queueEntries)
    .where(
      and(
        eq(queueEntries.workspaceId, workspaceId),
        eq(queueEntries.externalId, ref)
      )
    );

  const [runRows, queueRows] = await Promise.all([runPromise, queuePromise]);

  return {
    runs: runRows as WorkspaceRun[],
    queueEntries: queueRows as WorkspaceQueueEntry[],
  };
}
