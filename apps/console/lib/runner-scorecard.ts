/**
 * Runner Scorecard Aggregator — the single source of truth.
 *
 * Merges per-runner Postgres run stats with ClickHouse cost and context
 * efficiency rows into typed scorecard rows. No DB calls here; all inputs are
 * plain data so this module is unit-testable without any infrastructure.
 *
 * Metrics:
 *   success_rate         = success_count / total_count  (null when total = 0)
 *   review_fix_rate      = review_fix_count / total_count  (null when total = 0)
 *   human_review_rate    = human_review_count / total_count  (null when total = 0)
 *   cost_per_merged_pr   = total_cost_usd / success_count  (null when no cost data or success = 0)
 *   context_efficiency   = tokens_saved_sum / token_budget_sum  (null when no eff data or budget = 0)
 */
import type { RunnerRunStatsRow } from "@agentrail/db-postgres";
import type { RunnerCostStatsRow, RunnerContextEfficiencyRow } from "@agentrail/db-clickhouse";

export type { RunnerRunStatsRow, RunnerCostStatsRow, RunnerContextEfficiencyRow };

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
  const costByRunner = new Map(costRows.map((r) => [r.runner_name, r]));
  const effByRunner = new Map(effRows.map((r) => [r.runner_name, r]));

  return pgRows.map((pg) => {
    const cost = costByRunner.get(pg.runner_name);
    const eff = effByRunner.get(pg.runner_name);

    const success_rate = pg.total_count > 0 ? pg.success_count / pg.total_count : null;
    const review_fix_rate = pg.total_count > 0 ? pg.review_fix_count / pg.total_count : null;
    const human_review_rate = pg.total_count > 0 ? pg.human_review_count / pg.total_count : null;

    const cost_per_merged_pr =
      cost !== undefined && pg.success_count > 0
        ? cost.total_cost_usd / pg.success_count
        : null;

    const context_efficiency =
      eff !== undefined && eff.token_budget_sum > 0
        ? eff.tokens_saved_sum / eff.token_budget_sum
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
