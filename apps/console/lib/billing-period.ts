/**
 * Shared UTC-calendar-month billing-period helper (subscription-platform
 * spec `docs/superpowers/specs/2026-07-29-subscription-platform-design.md`;
 * slice 6 plan Task 2, `docs/superpowers/plans/2026-07-31-subscription-
 * console-slice6.md`). Extracted verbatim from
 * `app/api/v1/runner/claim/route.ts` (its original, route-local home) so
 * `plan-card-data.ts`'s digest loader can compute the SAME `[periodStart,
 * periodEnd)` window `countAccountRunsStartedInWindow` needs, without either
 * module importing the other. Pure, no `db` — zero behavior change from the
 * move: the claim route still calls this for both its workspace-budget and
 * capacity-gate blocks, and its existing test suite (real, unmocked `Date`
 * inputs via `vi.setSystemTime`) is the proof the move changed nothing.
 */

/**
 * The current UTC calendar month as both a stable "YYYY-MM" period key (the
 * markBudgetExhaustedNotified dedup key) and its [start, end) ISO bounds
 * (sumWorkspaceSpendSince's window). Bucketing is by `runs.created_at`,
 * stamped at CLAIM time, not completion — a coarse, honestly-documented
 * tradeoff (queries/workspace_budget.ts + issue #1269 PR② recon §1/§2): a run
 * claimed in the last minute of a month books to that month even if it
 * finishes into the next one, and an in-flight run's cost is invisible to
 * this SUM until it reports (self-hosted runners never heartbeat cost).
 */
export function currentBudgetWindow(now: Date = new Date()): {
  period: string;
  periodStartIso: string;
  periodEndIso: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStartIso = new Date(Date.UTC(year, month, 1)).toISOString();
  const periodEndIso = new Date(Date.UTC(year, month + 1, 1)).toISOString();
  const period = `${year}-${String(month + 1).padStart(2, "0")}`;
  return { period, periodStartIso, periodEndIso };
}
