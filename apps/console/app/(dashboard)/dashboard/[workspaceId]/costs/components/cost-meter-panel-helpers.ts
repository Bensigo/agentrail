import { timeRangeToFrom, type TimeRange } from "./cost-filters";

export interface IssueCost {
  issueKey: string;
  costUsd: number;
}

export interface CostPerIssueToGreen {
  issues: IssueCost[];
  greenIssueCount: number;
  avgCostUsd: number | null;
}

export interface CacheReadCreationRatio {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ratio: number | null;
}

export interface CostMeterData {
  costPerIssueToGreen: CostPerIssueToGreen;
  cacheRatio: CacheReadCreationRatio;
}

export const EMPTY_STATE_COPY =
  "No completed issues reached Green in the selected period";

export function buildMeterUrl({
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
  const url = new URL(`/api/v1/workspaces/${workspaceId}/costs/meter`, origin);
  const from = timeRangeToFrom(timeRange, now);
  if (from) {
    url.searchParams.set("time_from", from.toISOString());
    url.searchParams.set("time_to", now.toISOString());
  }
  return url.toString();
}

/** $X.XX formatting for Cost-per-Issue-to-Green dollar values. */
export function formatCostUsd(usd: number): string {
  if (usd < 0.01 && usd > 0) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Formats the cache read-to-creation ratio. `null` (no cache-creation tokens
 * yet) renders as an em dash. The ratio is falsifiable: below 1.0× means cache
 * writes have not yet paid for themselves in reads.
 */
export function formatCacheRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${ratio.toFixed(2)}×`;
}

/** Short token count for the ratio caption (e.g. 1.2M, 53.0k, 412). */
export function formatTokens(n: number): string {
  if (n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export type MeterState = "loading" | "error" | "empty" | "data";

export function resolveMeterState({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error: string | null;
  data: CostMeterData | null;
}): MeterState {
  if (loading) return "loading";
  if (error) return "error";
  if (!data) return "empty";
  const hasGreen = data.costPerIssueToGreen.greenIssueCount > 0;
  const hasCache =
    data.cacheRatio.cacheReadTokens > 0 ||
    data.cacheRatio.cacheCreationTokens > 0;
  if (!hasGreen && !hasCache) return "empty";
  return "data";
}
