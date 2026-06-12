/**
 * Scorecard derivation — the single source of truth.
 *
 * Merges per-agent Postgres stats and per-model ClickHouse cost rows into
 * typed scorecard tables. No DB calls here; all inputs are plain data so
 * this module is unit-testable without any infrastructure.
 */
import type { AgentRunStatsRow } from "@agentrail/db-postgres";
import type { AgentModelCostRow } from "@agentrail/db-clickhouse";

export type { AgentRunStatsRow, AgentModelCostRow };

export interface AgentScorecardRow {
  agent: string;
  runs: number;
  finishedRuns: number;
  successRate: number;
  avgDurationS: number | null;
  avgReviewRounds: number;
}

export interface ModelScorecardRow {
  model: string;
  runs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheRatio: number;
}

export interface Scorecard {
  agents: AgentScorecardRow[];
  models: ModelScorecardRow[];
}

export function buildScorecard(
  pgRows: AgentRunStatsRow[],
  chRows: AgentModelCostRow[]
): Scorecard {
  const agents: AgentScorecardRow[] = pgRows.map((r) => ({
    agent: r.agent,
    runs: r.runCount,
    finishedRuns: r.finishedCount,
    successRate: r.finishedCount > 0 ? r.successCount / r.finishedCount : 0,
    avgDurationS: r.avgDurationS,
    avgReviewRounds: r.avgReviewRounds,
  }));

  const models: ModelScorecardRow[] = chRows.map((r) => {
    const denominator = r.inputTokens + r.outputTokens + r.cacheTokens;
    return {
      model: r.model,
      runs: r.runCount,
      totalCostUsd: r.totalCostUsd,
      avgCostUsd: r.runCount > 0 ? r.totalCostUsd / r.runCount : 0,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheTokens: r.cacheTokens,
      cacheRatio: denominator > 0 ? r.cacheTokens / denominator : 0,
    };
  });

  return { agents, models };
}
