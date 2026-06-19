import { client } from "./client";

export type MetricKey =
  | "precision_at_budget"
  | "citation_coverage"
  | "stale_count"
  | "denied_count";

/**
 * One point per calendar day in the window. Metric values are `null` on days
 * with no runs — NEVER zero. Zero-filling a gap day made every percentage line
 * crash to 0% between sparse runs ("always down"); `null` + `connectNulls` lets
 * the chart bridge the gap so the line reflects actual run quality. `run_count`
 * is how many runs landed on that day (0 on gap days), used for tooltips.
 */
export interface QualitySeriesPoint {
  date: string;
  precision_at_budget: number | null;
  citation_coverage: number | null;
  stale_count: number | null;
  denied_count: number | null;
  run_count: number;
}

/**
 * Unified result — always returns whatever data exists so the UI can degrade
 * gracefully instead of hitting a blank "insufficient data" wall.
 *
 * - `insufficient_data` means the rolling baseline is NOT trustworthy (fewer
 *   than MIN_RUNS runs, or no runs before the latest run-day). The series and
 *   `latest` values are still populated when any runs exist; only `baseline`
 *   and `regression` are suppressed.
 * - `latest` / `latest_date` describe the most recent run-day's average, which
 *   drives the KPI tiles.
 */
export interface QualityMetricsResult {
  insufficient_data: boolean;
  run_count: number;
  series: QualitySeriesPoint[];
  latest: Record<MetricKey, number | null>;
  latest_date: string | null;
  baseline: Record<MetricKey, number | null>;
  regression: Record<MetricKey, boolean>;
}

export interface QualityMetricsOpts {
  workspaceId: string;
  repositoryId?: string;
  from: Date;
  to: Date;
  /**
   * Rolling baseline window in days. Default 30, clamped to [7, 90]. Callers
   * should set `from` to `to - windowDays days` when building the request; this
   * parameter is used for clamping validation only.
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

const METRIC_KEYS: MetricKey[] = [
  "precision_at_budget",
  "citation_coverage",
  "stale_count",
  "denied_count",
];

/** Minimum runs before a rolling baseline (and regression flags) is trustworthy. */
export const MIN_RUNS = 5;

const NULL_METRICS: Record<MetricKey, number | null> = {
  precision_at_budget: null,
  citation_coverage: null,
  stale_count: null,
  denied_count: null,
};

const NO_REGRESSION: Record<MetricKey, boolean> = {
  precision_at_budget: false,
  citation_coverage: false,
  stale_count: false,
  denied_count: false,
};

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
 * context_packs and returns a per-day series (null on gap days), the most
 * recent run-day's values, a rolling baseline, and regression flags.
 *
 * Design decisions:
 * - Gap policy: series carries one entry per calendar day in [from, to]; days
 *   with no runs carry `null` (NOT 0) for every metric, plus run_count 0. The
 *   frontend bridges nulls with `connectNulls` so a sparse cadence reads as a
 *   continuous quality line instead of a sawtooth crashing to zero.
 * - Baseline: median across individual run values strictly before the most
 *   recent run day (median is robust to single-run outliers). Suppressed
 *   (null) until there are >= MIN_RUNS runs AND at least one run before the
 *   latest day.
 * - Regression thresholds (only evaluated when the baseline is ready):
 *     precision_at_budget / citation_coverage: regress when latest drops more
 *       than 5 percentage points below the baseline median.
 *     stale_count / denied_count: regress when latest exceeds the baseline
 *       median by more than 10%, or when baseline is 0 and latest > 0.
 */
export function computeQualityMetrics(
  rows: QualityPackRow[],
  opts: { from: Date; to: Date }
): QualityMetricsResult {
  const series = buildSeries(rows, opts);

  if (rows.length === 0) {
    return {
      insufficient_data: true,
      run_count: 0,
      series,
      latest: { ...NULL_METRICS },
      latest_date: null,
      baseline: { ...NULL_METRICS },
      regression: { ...NO_REGRESSION },
    };
  }

  // Sort by occurred_at ascending.
  const sorted = [...rows].sort(
    (a, b) => toUTCDay(a.occurred_at).getTime() - toUTCDay(b.occurred_at).getTime()
  );

  // Most recent run day and its average per metric.
  const latestRunDayStr = toDateStr(toUTCDay(sorted[sorted.length - 1]!.occurred_at));
  const latestRows = sorted.filter(
    (r) => toDateStr(toUTCDay(r.occurred_at)) === latestRunDayStr
  );
  const avg = (key: MetricKey, rs: QualityPackRow[]) =>
    rs.reduce((s, r) => s + r[key], 0) / rs.length;
  const latest: Record<MetricKey, number | null> = {
    precision_at_budget: avg("precision_at_budget", latestRows),
    citation_coverage: avg("citation_coverage", latestRows),
    stale_count: avg("stale_count", latestRows),
    denied_count: avg("denied_count", latestRows),
  };

  // Baseline: runs strictly before the latest run day.
  const priorRows = sorted.filter(
    (r) => toDateStr(toUTCDay(r.occurred_at)) !== latestRunDayStr
  );
  const baselineReady = rows.length >= MIN_RUNS && priorRows.length > 0;

  if (!baselineReady) {
    return {
      insufficient_data: true,
      run_count: rows.length,
      series,
      latest,
      latest_date: latestRunDayStr,
      baseline: { ...NULL_METRICS },
      regression: { ...NO_REGRESSION },
    };
  }

  const baseline: Record<MetricKey, number> = {
    precision_at_budget: median(priorRows.map((r) => r.precision_at_budget)),
    citation_coverage: median(priorRows.map((r) => r.citation_coverage)),
    stale_count: median(priorRows.map((r) => r.stale_count)),
    denied_count: median(priorRows.map((r) => r.denied_count)),
  };

  const regression: Record<MetricKey, boolean> = {
    precision_at_budget: latest.precision_at_budget! < baseline.precision_at_budget - 0.05,
    citation_coverage: latest.citation_coverage! < baseline.citation_coverage - 0.05,
    stale_count:
      baseline.stale_count === 0
        ? latest.stale_count! > 0
        : latest.stale_count! > baseline.stale_count * 1.1,
    denied_count:
      baseline.denied_count === 0
        ? latest.denied_count! > 0
        : latest.denied_count! > baseline.denied_count * 1.1,
  };

  return {
    insufficient_data: false,
    run_count: rows.length,
    series,
    latest,
    latest_date: latestRunDayStr,
    baseline,
    regression,
  };
}

/**
 * Build the per-day series: one entry per calendar day in [from, to], with
 * `null` metrics (and run_count 0) on days that had no runs. Days with runs
 * carry that day's average per metric.
 */
function buildSeries(
  rows: QualityPackRow[],
  opts: { from: Date; to: Date }
): QualitySeriesPoint[] {
  const byDay = new Map<string, Record<MetricKey, number[]>>();
  for (const row of rows) {
    const dayStr = toDateStr(toUTCDay(row.occurred_at));
    let bucket = byDay.get(dayStr);
    if (!bucket) {
      bucket = {
        precision_at_budget: [],
        citation_coverage: [],
        stale_count: [],
        denied_count: [],
      };
      byDay.set(dayStr, bucket);
    }
    for (const key of METRIC_KEYS) bucket[key].push(row[key]);
  }

  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const series: QualitySeriesPoint[] = [];
  const cur = new Date(toUTCDay(opts.from));
  const toDay = toUTCDay(opts.to);
  while (cur <= toDay) {
    const dayStr = toDateStr(cur);
    const bucket = byDay.get(dayStr);
    if (bucket) {
      series.push({
        date: dayStr,
        precision_at_budget: mean(bucket.precision_at_budget),
        citation_coverage: mean(bucket.citation_coverage),
        stale_count: mean(bucket.stale_count),
        denied_count: mean(bucket.denied_count),
        run_count: bucket.precision_at_budget.length,
      });
    } else {
      series.push({
        date: dayStr,
        precision_at_budget: null,
        citation_coverage: null,
        stale_count: null,
        denied_count: null,
        run_count: 0,
      });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return series;
}

/**
 * Fetch quality metrics from ClickHouse for the given workspace (and optionally
 * repository) over the specified time range, then delegate to
 * `computeQualityMetrics`.
 *
 * `windowDays` is clamped to [7, 90]; callers are expected to set `from` to
 * `to - windowDays days` when constructing the request.
 *
 * Repository filtering reads the `repository_id` column on `context_packs`
 * directly. (It previously joined `run_events`, whose `repository_id` is empty
 * in production, so every repo filter returned no rows.) Packs ingested before
 * the column existed default to '' and won't match a specific-repo filter.
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
    repoFilter = `AND repository_id = {repositoryId: String}`;
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
