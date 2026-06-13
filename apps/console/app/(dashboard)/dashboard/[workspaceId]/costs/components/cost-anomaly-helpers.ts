import { timeRangeToFrom, type TimeRange } from "./cost-filters";

export interface CostAnomalyRow {
  run_id: string;
  model: string;
  phase: string;
  repository_id: string;
  cost_usd: number;
  mean: number;
  stddev: number;
  deviation_sigmas: number;
  occurred_at: string;
}

export function formatDeviationSigma(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}σ`;
}

export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export function getBaselineThreshold(
  row: Pick<CostAnomalyRow, "mean" | "stddev">
): number {
  return row.mean + 2 * row.stddev;
}

export function formatBaselineLabel(
  row: Pick<CostAnomalyRow, "mean" | "stddev">
): string {
  return `Baseline: ${formatCostUsd(getBaselineThreshold(row))} (mean + 2σ over 30d)`;
}

export function buildCostAnomaliesUrl({
  workspaceId,
  origin,
  timeRange,
  now = new Date(),
}: {
  workspaceId: string;
  origin: string;
  timeRange: TimeRange;
  now?: Date;
}): string {
  const url = new URL(`/api/v1/workspaces/${workspaceId}/costs/anomalies`, origin);
  const from = timeRangeToFrom(timeRange, now);
  if (from) {
    url.searchParams.set("time_from", from.toISOString());
    url.searchParams.set("time_to", now.toISOString());
  }
  return url.toString();
}
