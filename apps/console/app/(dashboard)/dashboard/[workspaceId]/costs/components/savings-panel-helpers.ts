import { timeRangeToFrom, type TimeRange } from "./cost-filters";

export interface SavingsData {
  tokensSaved: number;
  dollarsSaved: number;
  model: string;
  ratePerMtok: number;
  estimateFlag: boolean;
}

export interface SavingsResponse {
  savings: SavingsData;
  agentBreakdown: {
    agent: string;
    totalCostUsd: number;
    dollarsSaved: number;
    eventCount: number;
  }[];
}

export const EMPTY_STATE_COPY =
  "No context-pack telemetry for the selected period";

export function buildSavingsUrl({
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
  const url = new URL(
    `/api/v1/workspaces/${workspaceId}/costs/savings`,
    origin
  );
  const from = timeRangeToFrom(timeRange, now);
  if (from) {
    url.searchParams.set("time_from", from.toISOString());
  }
  return url.toString();
}

export function formatSavingsUsd(dollars: number, estimateFlag: boolean): string {
  const formatted = `$${dollars.toFixed(2)}`;
  return estimateFlag ? `~${formatted}` : formatted;
}

export function formatEstimateMarker(model: string, ratePerMtok: number): string {
  return `${model} @ $${ratePerMtok.toFixed(2)}/Mtok`;
}

export type SavingsState = "loading" | "error" | "empty" | "data";

export function resolveSavingsState({
  loading,
  error,
  savings,
}: {
  loading: boolean;
  error: string | null;
  savings: SavingsData | null;
}): SavingsState {
  if (loading) return "loading";
  if (error) return "error";
  if (!savings || savings.tokensSaved === 0) return "empty";
  return "data";
}
