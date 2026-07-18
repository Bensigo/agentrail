import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db.js";
import { workspaces } from "../schema/workspaces.js";
import { runs } from "../schema/runs.js";

/**
 * Workspace monthly-budget-ceiling queries (issue #1269 PR ②a).
 *
 * `getWorkspaceBudgetState` + `sumWorkspaceSpendSince` are the claim route's
 * read path: it reads the ceiling FIRST and only runs the (index-backed, but
 * still non-free) spend SUM when a ceiling is actually set — most workspaces
 * have `monthly_budget_usd = null` (uncapped, the product default until
 * billing #1290), so their claim polls never touch `runs` for this check at
 * all. `markBudgetExhaustedNotified` is the once-per-period notify dedup: an
 * atomic compare-and-set so two concurrent blocked claims for the same
 * workspace can never both send the ceiling-hit chat notice.
 *
 * Period bucketing is deliberately coarse and by `runs.created_at` (claim
 * time, not completion time) — the SAME tradeoff `runs.created_at`'s own
 * schema doc-comment and issue #1269 PR② recon §1/§2 describe: a run claimed
 * in the last minute of a month books its cost to that month even if it
 * finishes into the next one, and a currently-`running` run's cost is
 * invisible to the SUM until it reports (self-hosted runners never heartbeat
 * cost). This is a workspace-level guardrail on TOP of the per-issue leash,
 * not a real-time meter — granular, real-time cost visibility is #1272's
 * ClickHouse surface, not this.
 */

export interface WorkspaceBudgetState {
  monthlyBudgetUsd: number | null;
  budgetExhaustedNotifiedPeriod: string | null;
}

/**
 * The workspace's ceiling + its last-notified period, in one row. Returns
 * `null` only if the workspace row itself does not exist (defensive — the
 * claim route only ever calls this for a workspace its own bearer auth just
 * validated ownership against).
 */
export async function getWorkspaceBudgetState(
  workspaceId: string
): Promise<WorkspaceBudgetState | null> {
  const [row] = await db
    .select({
      monthlyBudgetUsd: workspaces.monthlyBudgetUsd,
      budgetExhaustedNotifiedPeriod: workspaces.budgetExhaustedNotifiedPeriod,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

/**
 * Sum of `runs.cost_usd` for `workspaceId` within `[periodStartIso,
 * periodEndIso)` — a half-open window so the caller controls both edges
 * explicitly (rather than this function reaching for `now()` itself), backed
 * by the `runs_workspace_id_created_at_idx` composite index (migration
 * 0034). NULL-safe: `COALESCE` so a workspace with zero runs in the window
 * (or all-NULL `cost_usd`, pre-#891a rows) sums to `0`, never `null`.
 */
export async function sumWorkspaceSpendSince(
  workspaceId: string,
  periodStartIso: string,
  periodEndIso: string
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${runs.costUsd}), 0)`,
    })
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        gte(runs.createdAt, new Date(periodStartIso)),
        lt(runs.createdAt, new Date(periodEndIso))
      )
    );
  return row?.total ?? 0;
}

/**
 * Atomically flip `budget_exhausted_notified_period` to `period` — ONLY when
 * it does not already equal `period` — and report whether THIS call was the
 * one that flipped it. `IS DISTINCT FROM` (rather than `!=`) is required so
 * the very first notify (column starts `NULL`) still matches: plain `!=`
 * against NULL is unknown, never true, and would never flip.
 *
 * This is the WHOLE race-safety mechanism (no advisory lock, no separate
 * `notified_at` check-then-set): two concurrent blocked claims for the same
 * workspace both attempt this UPDATE, but only one can win the row (Postgres
 * serializes concurrent UPDATEs to the same row), so only one ever gets
 * `true` back. The caller MUST send the chat notice iff this returns `true`
 * — never on a read-then-write check, which would reintroduce the race.
 *
 * A later call with a DIFFERENT `period` (e.g. the ceiling was raised, spend
 * crossed it again next month) flips again — this column only remembers the
 * MOST RECENT notified period, not history, so re-exhaustion within the SAME
 * period after a raise does not re-notify (documented tradeoff: spam beats
 * silence the other way, but this is a deliberate v1 simplification, not an
 * oversight).
 */
export async function markBudgetExhaustedNotified(
  workspaceId: string,
  period: string
): Promise<boolean> {
  const result = await db
    .update(workspaces)
    .set({ budgetExhaustedNotifiedPeriod: period })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        sql`${workspaces.budgetExhaustedNotifiedPeriod} IS DISTINCT FROM ${period}`
      )
    )
    .returning({ id: workspaces.id });
  return result.length > 0;
}
