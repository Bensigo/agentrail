import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db.js";
import { runs } from "../schema/runs.js";

/**
 * Per-workspace cost aggregation reads (issue #1272 PR ①). Consumed by the
 * console workspace-costs page (PR ②, an RSC read — no API route needed).
 *
 * Honesty caveats this whole file inherits from #1269 PR ②a
 * (queries/workspace_budget.ts) and its recon (issue #1269 PR② annex §1/§2)
 * — repeated here because every function below reads the same `runs` rows:
 *   - Costs land ONCE, at terminal report (`recordRunnerResult`,
 *     queries/runner.ts) — an in-flight `running` run's spend is invisible
 *     until it finishes. These are historical numbers, not a real-time meter.
 *   - Bucketing is by `runs.created_at` (claim time), not completion time —
 *     a run claimed in the last minute of a month books to that month even
 *     if it finishes into the next one.
 *   - This is the coarse Postgres surface. ClickHouse's `cost_events`
 *     (packages/db-clickhouse) is the granular per-phase/per-token-type path
 *     — not duplicated here.
 *   - Per-issue budget caps (the $3 default leash / --budget-usd) are
 *     factory-side (agentrail/run) config, enforced and recorded into each
 *     run's own `run.json` (`blockedReason` / `budgetCeilingCrossed`, #1316)
 *     — invisible to this workspace-level surface. `getWorkspaceCostOverview`
 *     below only ever reports the WORKSPACE monthly ceiling (#1269), never
 *     a per-issue one.
 */

/** A page's worth of recent per-task rows for the cost detail view; the
 * monthly rollup is what a chart/summary reads, this is just recent detail.
 * Callers needing more history can pass an explicit larger limit. */
export const DEFAULT_RUN_COST_LIST_LIMIT = 50;

export interface WorkspaceRunCostRow {
  runId: string;
  /** Human-meaningful task identity — NEVER the bare run id/UUID (house UI
   * rule). `runs.title` is already a denormalized copy of the originating
   * queue entry's title (written once, at claim time — see
   * queries/runner.ts's `claimQueueEntry`) or whatever the caller passed
   * directly (`upsertRun`, the non-queue CLI-direct path, where `title` is
   * optional and can be `null`). `runs.branch` is `NOT NULL` on both
   * insertion paths, so it is the fallback when title is absent — no join to
   * `queue_entries` is needed (see this file's own recon note below). */
  taskIdentity: string;
  status: "queued" | "running" | "success" | "failed";
  costUsd: number;
  createdAt: string;
}

/**
 * Per-task cost rows for `workspaceId` within `[periodStartIso,
 * periodEndIso)`, newest-first. Half-open window for the same reason
 * `sumWorkspaceSpendSince` is: the caller controls both edges explicitly.
 * Backed by the same `runs_workspace_id_created_at_idx` composite index
 * (migration 0034) `sumWorkspaceSpendSince` uses.
 *
 * Join-shape recon (verified by reading, not assumed): `runs.queue_entry_id`
 * is a bare nullable uuid column — no DB-level FK exists anywhere in the
 * migrations, and no `.references()` call exists in the Drizzle schema
 * either. For a queue-driven run, `claimQueueEntry` (queries/runner.ts) sets
 * BOTH `runs.id` and `runs.queue_entry_id` to the SAME value (the queue
 * entry's own id) AND copies `title` across at insert time — so
 * `runs.queue_entry_id` never carries information `runs.id`/`runs.title`
 * don't already have. A join to `queue_entries` would be redundant for this
 * query; reading `runs.title` (with the `branch` fallback above) directly is
 * both simpler and strictly equivalent for the queue-driven path, and is the
 * ONLY option for the non-queue `upsertRun` path anyway (those rows have no
 * `queue_entries` row at all — `queue_entry_id` is left null).
 */
export async function listWorkspaceRunCosts(
  workspaceId: string,
  periodStartIso: string,
  periodEndIso: string,
  limit: number = DEFAULT_RUN_COST_LIST_LIMIT
): Promise<WorkspaceRunCostRow[]> {
  const rows = await db
    .select({
      id: runs.id,
      taskIdentity: sql<string>`COALESCE(${runs.title}, ${runs.branch})`,
      status: runs.status,
      costUsd: sql<number>`COALESCE(${runs.costUsd}, 0)`,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        gte(runs.createdAt, new Date(periodStartIso)),
        lt(runs.createdAt, new Date(periodEndIso))
      )
    )
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    runId: r.id,
    taskIdentity: r.taskIdentity,
    status: r.status,
    costUsd: r.costUsd ?? 0,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}
