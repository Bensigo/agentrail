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

/** Default months of history the rollup returns (including the current
 * partial month) — enough for a trailing trend chart without an explicit
 * caller-supplied window. */
export const DEFAULT_MONTHLY_ROLLUP_MONTHS = 6;

export interface WorkspaceMonthlyCostRow {
  /** UTC "YYYY-MM", same format as workspace_budget.ts's `period` key. */
  monthKey: string;
  totalCostUsd: number;
  runCount: number;
}

/**
 * The UTC month, `monthsAgo` months before `now` (0 = the current, partial,
 * month) — mirrors apps/console/app/api/v1/runner/claim/route.ts's
 * `currentBudgetWindow` (lines ~33-44) EXACTLY: same `Date.UTC(year, month,
 * 1)` / `Date.UTC(year, month + 1, 1)` half-open construction and the same
 * "YYYY-MM" key format, generalized to step back an arbitrary number of
 * months instead of only "this month". That route's helper cannot be
 * imported here (it lives in apps/console, a downstream consumer of this
 * package, not a dependency of it) — this is a parallel implementation of
 * the SAME convention, not a copy of the SAME symbol. JS `Date.UTC`
 * normalizes an out-of-range month index by carrying into the year, so
 * stepping back across a year boundary needs no special-casing.
 */
function utcMonthWindow(
  monthsAgo: number,
  now: Date
): { key: string; startIso: string; endIso: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - monthsAgo;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { key, startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * One row per UTC calendar month for `workspaceId`, oldest-first, ending at
 * (and including) the current partial month — `monthsBack` total rows.
 * Months with no runs still get a row (`totalCostUsd: 0, runCount: 0`) so a
 * trend chart never shows a gap.
 *
 * Buckets in a single grouped query rather than `monthsBack` round trips.
 * Deliberately uses `EXTRACT(YEAR/MONTH FROM created_at AT TIME ZONE
 * 'UTC')::int` instead of `date_trunc(...)`, for two reasons verified before
 * writing this:
 *   1. postgres.js (this package's driver, packages/db-postgres/src/db.ts)
 *      returns `bigint`/`numeric` columns as STRINGS by default (no custom
 *      type parsers are registered) — an uncast `COUNT(*)` would land as
 *      `"3"`, not `3`. The explicit `::int` cast (int4) is what makes it
 *      come back as a genuine JS number.
 *   2. `date_trunc('month', created_at AT TIME ZONE 'UTC')` would return a
 *      timestamp already shifted to UTC wall-clock but WITHOUT a timezone
 *      marker on the wire — and postgres.js's date parser is a plain `new
 *      Date(x)`, which parses a marker-less date-time string as LOCAL time,
 *      not UTC. Round-tripping the bucket through a timestamp value would
 *      silently reintroduce a timezone bug on any machine whose local TZ
 *      isn't UTC. Returning two small cast integers sidesteps this
 *      entirely — no timestamp value crosses the wire for the bucket key.
 *
 * NULL-safe the same way `sumWorkspaceSpendSince` is: `COALESCE(SUM(...),
 * 0)` in SQL (a group made entirely of legacy NULL `cost_usd` rows sums to
 * NULL otherwise) plus a JS-level `?? 0` belt-and-braces fallback.
 */
export async function workspaceMonthlyCostRollup(
  workspaceId: string,
  monthsBack: number = DEFAULT_MONTHLY_ROLLUP_MONTHS,
  now: Date = new Date()
): Promise<WorkspaceMonthlyCostRow[]> {
  const span = Math.max(1, Math.trunc(monthsBack));
  // Oldest -> newest, ending at (and including) the current partial month.
  const months = Array.from({ length: span }, (_, i) => utcMonthWindow(span - 1 - i, now));
  const windowStartIso = months[0]!.startIso;
  const windowEndIso = utcMonthWindow(0, now).endIso;

  const yearExpr = sql`EXTRACT(YEAR FROM ${runs.createdAt} AT TIME ZONE 'UTC')::int`;
  const monthExpr = sql`EXTRACT(MONTH FROM ${runs.createdAt} AT TIME ZONE 'UTC')::int`;

  const result = await db.execute(sql`
    SELECT
      ${yearExpr} AS bucket_year,
      ${monthExpr} AS bucket_month,
      COALESCE(SUM(${runs.costUsd}), 0) AS total_cost_usd,
      COUNT(*)::int AS run_count
    FROM ${runs}
    WHERE ${runs.workspaceId} = ${workspaceId}
      AND ${runs.createdAt} >= ${new Date(windowStartIso)}
      AND ${runs.createdAt} < ${new Date(windowEndIso)}
    GROUP BY ${yearExpr}, ${monthExpr}
    ORDER BY ${yearExpr} ASC, ${monthExpr} ASC
  `);

  const byKey = new Map<string, { totalCostUsd: number; runCount: number }>();
  for (const row of Array.from(result) as Record<string, unknown>[]) {
    const bucketYear = Number(row.bucket_year);
    const bucketMonth = Number(row.bucket_month);
    const key = `${bucketYear}-${String(bucketMonth).padStart(2, "0")}`;
    byKey.set(key, {
      totalCostUsd: Number(row.total_cost_usd ?? 0),
      runCount: Number(row.run_count ?? 0),
    });
  }

  return months.map(({ key }) => ({
    monthKey: key,
    totalCostUsd: byKey.get(key)?.totalCostUsd ?? 0,
    runCount: byKey.get(key)?.runCount ?? 0,
  }));
}
