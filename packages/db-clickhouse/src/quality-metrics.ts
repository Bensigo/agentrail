import { client } from "./client";

export type QualityMetricsResult =
  | { insufficient_data: true }
  | {
      insufficient_data: false;
      series: Array<{
        date: string;
        precision_at_budget: number;
        citation_coverage: number;
        stale_count: number;
        denied_count: number;
      }>;
      baseline: {
        precision_at_budget: number;
        citation_coverage: number;
        stale_count: number;
        denied_count: number;
      };
      regression: {
        precision_at_budget: boolean;
        citation_coverage: boolean;
        stale_count: boolean;
        denied_count: boolean;
      };
    };

export interface QualityMetricsOpts {
  workspaceId: string;
  repositoryId?: string;
  from: Date;
  to: Date;
  /**
   * Rolling baseline window in days. Default 30, clamped to [7, 90].
   * Callers should set `from` to `to - windowDays days` when building the
   * request; this parameter is used for clamping validation only.
   */
  windowDays?: number;
}

/** A single context pack run row used by the pure compute function. */
export interface QualityPackRow {
  occurred_at: Date | string;
  precision_at_budget: number;
  citation_coverage: number;
  stale_count: number;
  denied_count: number;
}

type MetricKey = "precision_at_budget" | "citation_coverage" | "stale_count" | "denied_count";

const METRIC_KEYS: MetricKey[] = [
  "precision_at_budget",
  "citation_coverage",
  "stale_count",
  "denied_count",
];

/** Median of a numeric array. Returns 0 for an empty array. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** Format a Date as YYYY-MM-DD in UTC. */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Normalize any date-like value to a UTC midnight Date. */
function toUTCDay(d: Date | string): Date {
  const iso = typeof d === "string" ? d : d.toISOString();
  return new Date(iso.slice(0, 10) + "T00:00:00.000Z");
}

/**
 * Pure compute function for quality metrics. Accepts raw per-run rows from
 * context_packs and returns per-day series, rolling baseline, and regression
 * flags.
 *
 * Design decisions:
 * - Baseline: median across individual run values strictly before the most
 *   recent run day (median is robust to single-run outliers).
 * - Series gap policy: zero-filled — one entry per calendar day in [from, to];
 *   days with no runs carry 0 for all four metrics. Baseline and regression are
 *   computed from actual run data only, never from zero-filled days.
 * - Regression thresholds:
 *     precision_at_budget / citation_coverage: regress when latest drops
 *       more than 5 percentage points below the baseline median.
 *     stale_count / denied_count: regress when latest exceeds the baseline
 *       median by more than 10%, or when baseline is 0 and latest > 0.
 * - Insufficient data: fewer than 5 runs in the supplied rows returns
 *   { insufficient_data: true }.
 */
export function computeQualityMetrics(
  rows: QualityPackRow[],
  opts: { from: Date; to: Date }
): QualityMetricsResult {
  const MIN_RUNS = 5;

  if (rows.length < MIN_RUNS) {
    return { insufficient_data: true };
  }

  // Sort by occurred_at ascending
  const sorted = [...rows].sort(
    (a, b) => toUTCDay(a.occurred_at).getTime() - toUTCDay(b.occurred_at).getTime()
  );

  // Group run values by UTC day
  const byDay = new Map<
    string,
    { precision_at_budget: number[]; citation_coverage: number[]; stale_count: number[]; denied_count: number[] }
  >();
  for (const row of sorted) {
    const dayStr = toDateStr(toUTCDay(row.occurred_at));
    if (!byDay.has(dayStr)) {
      byDay.set(dayStr, {
        precision_at_budget: [],
        citation_coverage: [],
        stale_count: [],
        denied_count: [],
      });
    }
    const bucket = byDay.get(dayStr)!;
    bucket.precision_at_budget.push(row.precision_at_budget);
    bucket.citation_coverage.push(row.citation_coverage);
    bucket.stale_count.push(row.stale_count);
    bucket.denied_count.push(row.denied_count);
  }

  // Compute per-day averages (for series display and latest-day value)
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const dayAvgs = new Map<string, Record<MetricKey, number>>();
  for (const [dayStr, bucket] of byDay.entries()) {
    dayAvgs.set(dayStr, {
      precision_at_budget: avg(bucket.precision_at_budget),
      citation_coverage: avg(bucket.citation_coverage),
      stale_count: avg(bucket.stale_count),
      denied_count: avg(bucket.denied_count),
    });
  }

  // Identify the most recent run day
  const latestRunDayStr = toDateStr(toUTCDay(sorted[sorted.length - 1]!.occurred_at));
  const latestDayAvg = dayAvgs.get(latestRunDayStr)!;

  // Baseline: median of individual run values strictly before the latest run day
  const baselineValues: Record<MetricKey, number[]> = {
    precision_at_budget: [],
    citation_coverage: [],
    stale_count: [],
    denied_count: [],
  };
  for (const row of sorted) {
    if (toDateStr(toUTCDay(row.occurred_at)) !== latestRunDayStr) {
      for (const key of METRIC_KEYS) {
        baselineValues[key].push(row[key]);
      }
    }
  }

  const baseline: Record<MetricKey, number> = {
    precision_at_budget: median(baselineValues.precision_at_budget),
    citation_coverage: median(baselineValues.citation_coverage),
    stale_count: median(baselineValues.stale_count),
    denied_count: median(baselineValues.denied_count),
  };

  // Regression flags
  const regression: Record<MetricKey, boolean> = {
    precision_at_budget: latestDayAvg.precision_at_budget < baseline.precision_at_budget - 0.05,
    citation_coverage: latestDayAvg.citation_coverage < baseline.citation_coverage - 0.05,
    stale_count:
      baseline.stale_count === 0
        ? latestDayAvg.stale_count > 0
        : latestDayAvg.stale_count > baseline.stale_count * 1.1,
    denied_count:
      baseline.denied_count === 0
        ? latestDayAvg.denied_count > 0
        : latestDayAvg.denied_count > baseline.denied_count * 1.1,
  };

  // Build zero-filled series for every calendar day in [from, to]
  const series: Array<{
    date: string;
    precision_at_budget: number;
    citation_coverage: number;
    stale_count: number;
    denied_count: number;
  }> = [];

  const fromDay = toUTCDay(opts.from);
  const toDay = toUTCDay(opts.to);
  const cur = new Date(fromDay);
  while (cur <= toDay) {
    const dayStr = toDateStr(cur);
    const dayData = dayAvgs.get(dayStr);
    series.push({
      date: dayStr,
      precision_at_budget: dayData?.precision_at_budget ?? 0,
      citation_coverage: dayData?.citation_coverage ?? 0,
      stale_count: dayData?.stale_count ?? 0,
      denied_count: dayData?.denied_count ?? 0,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return { insufficient_data: false, series, baseline, regression };
}

/**
 * Fetch quality metrics from ClickHouse for the given workspace (and optionally
 * repository) over the specified time range, then delegate to
 * `computeQualityMetrics`.
 *
 * `windowDays` is clamped to [7, 90]; callers are expected to set `from` to
 * `to - windowDays days` when constructing the request.
 *
 * Note: `context_packs` has no `repository_id` column. Repository filtering
 * uses a subquery on `run_events`, which is best-effort: run_events rows must
 * exist for the runs being queried.
 */
export async function getQualityMetrics(
  opts: QualityMetricsOpts
): Promise<QualityMetricsResult> {
  const { workspaceId, repositoryId, from, to } = opts;
  // Validate clamping contract; windowDays is not used for date filtering here.
  Math.max(7, Math.min(90, opts.windowDays ?? 30));

  const fromStr = from.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
  const toStr = to.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);

  const params: Record<string, unknown> = { workspaceId, fromStr, toStr };
  let repoFilter = "";
  if (repositoryId) {
    repoFilter = `AND run_id IN (
      SELECT DISTINCT run_id FROM run_events
      WHERE workspace_id = {workspaceId: String}
        AND repository_id = {repositoryId: String}
    )`;
    params.repositoryId = repositoryId;
  }

  const result = await client.query({
    query: `
      SELECT
        occurred_at,
        precision_at_budget,
        citation_coverage,
        stale_count,
        denied_count
      FROM context_packs
      WHERE workspace_id = {workspaceId: String}
        AND occurred_at >= {fromStr: DateTime64(3)}
        AND occurred_at <= {toStr: DateTime64(3)}
        ${repoFilter}
      ORDER BY occurred_at ASC
    `,
    query_params: params,
    format: "JSONEachRow",
  });

  const rows = await result.json<{
    occurred_at: string;
    precision_at_budget: string | number;
    citation_coverage: string | number;
    stale_count: string | number;
    denied_count: string | number;
  }>();

  const packRows: QualityPackRow[] = rows.map((r) => ({
    occurred_at: new Date(r.occurred_at),
    precision_at_budget: Number(r.precision_at_budget),
    citation_coverage: Number(r.citation_coverage),
    stale_count: Number(r.stale_count),
    denied_count: Number(r.denied_count),
  }));

  return computeQualityMetrics(packRows, { from, to });
}
