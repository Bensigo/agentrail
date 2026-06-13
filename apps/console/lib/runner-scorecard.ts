/**
 * Runner Scorecard Aggregator — the single source of truth.
 *
 * Merges per-runner Postgres run stats with ClickHouse cost and context
 * efficiency rows into typed scorecard rows. No DB calls here; all inputs are
 * plain data so this module is unit-testable without any infrastructure.
 *
 * Metrics:
 *   success_rate         = success_count / total_count  (null when total = 0)
 *   review_fix_rate      = review_fix_count / total_count  (null when total = 0 or source absent)
 *   human_review_rate    = human_review_count / total_count  (null when total = 0 or source absent)
 *   cost_per_merged_pr   = total_cost_usd / success_count  (null when no cost data or success = 0)
 *   context_efficiency   = tokens_saved_sum / token_budget_sum  (null when no eff data or budget = 0)
 */
import type { RunnerRunStatsRow } from "@agentrail/db-postgres";
import type { RunnerCostStatsRow, RunnerContextEfficiencyRow } from "@agentrail/db-clickhouse";

export type { RunnerRunStatsRow, RunnerCostStatsRow, RunnerContextEfficiencyRow };

function sumByRunId<T>(
  runIds: string[],
  rows: T[],
  valueForRow: (row: T) => number,
  runIdForRow: (row: T) => string
): { total: number; matched: number } {
  const wanted = new Set(runIds);
  return rows.reduce(
    (acc, row) => {
      if (!wanted.has(runIdForRow(row))) return acc;
      acc.total += valueForRow(row);
      acc.matched += 1;
      return acc;
    },
    { total: 0, matched: 0 }
  );
}

export interface RunnerScoreRow {
  runner_name: string;
  run_ids: string[];          // underlying run IDs for drill-down links
  success_rate: number | null;
  review_fix_rate: number | null;
  human_review_rate: number | null;
  cost_per_merged_pr: number | null;
  context_efficiency: number | null;
}

export function buildRunnerScorecard(
  pgRows: RunnerRunStatsRow[],
  costRows: RunnerCostStatsRow[],
  effRows: RunnerContextEfficiencyRow[]
): RunnerScoreRow[] {
  return pgRows.map((pg) => {
    const success_rate = pg.total_count > 0 ? pg.success_count / pg.total_count : null;
    const review_fix_rate =
      pg.total_count > 0 && pg.review_fix_count !== null
        ? pg.review_fix_count / pg.total_count
        : null;
    const human_review_rate =
      pg.total_count > 0 && pg.human_review_count !== null
        ? pg.human_review_count / pg.total_count
        : null;

    const cost = sumByRunId(
      pg.run_ids,
      costRows,
      (row) => row.total_cost_usd,
      (row) => row.run_id
    );
    const tokensSaved = sumByRunId(
      pg.run_ids,
      effRows,
      (row) => row.tokens_saved_sum,
      (row) => row.run_id
    );
    const tokenBudget = sumByRunId(
      pg.run_ids,
      effRows,
      (row) => row.token_budget_sum,
      (row) => row.run_id
    );

    const cost_per_merged_pr =
      cost.matched > 0 && pg.success_count > 0
        ? cost.total / pg.success_count
        : null;

    const context_efficiency =
      tokensSaved.matched > 0 && tokenBudget.total > 0
        ? tokensSaved.total / tokenBudget.total
        : null;

    return {
      runner_name: pg.runner_name,
      run_ids: pg.run_ids,
      success_rate,
      review_fix_rate,
      human_review_rate,
      cost_per_merged_pr,
      context_efficiency,
    };
  });
}
