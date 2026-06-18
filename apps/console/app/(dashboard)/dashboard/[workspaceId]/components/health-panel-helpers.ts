// Pure helpers for the system-health surface (M034 / ADR 0009). Accept rate and
// escalation rate are both falsifiable: accept rate can render below the 50%
// health line for a losing loop, which is exactly what the console display rule
// requires (no metric that cannot come back negative).

/** The accept-rate health line (> 50% = winning), from CONTEXT.md. */
export const ACCEPT_RATE_HEALTH_LINE = 0.5;

export interface HealthRates {
  attempted: number;
  green: number;
  escalated: number;
  acceptRate: number | null;
  escalationRate: number | null;
  belowHealthLine: boolean;
}

export interface HealthData {
  rates: HealthRates;
}

/** Renders a 0..1 rate as a whole-number percentage; `null` → em dash. */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export type HealthState = "loading" | "error" | "empty" | "data";

export function resolveHealthState({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error: string | null;
  data: HealthData | null;
}): HealthState {
  if (loading) return "loading";
  if (error) return "error";
  if (!data || data.rates.attempted === 0) return "empty";
  return "data";
}
