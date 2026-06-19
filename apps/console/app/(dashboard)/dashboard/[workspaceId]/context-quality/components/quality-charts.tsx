"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import {
  AlertTriangle,
  CheckCircle,
  ArrowUp,
  ArrowDown,
  Minus,
  Info,
  X,
} from "lucide-react";
import { Skeleton } from "../../../../../components/loading-skeleton";
import { RotScoreCard } from "./rot-score-card";

type RangeKey = "7d" | "30d" | "90d" | "custom";

type MetricKey =
  | "precision_at_budget"
  | "citation_coverage"
  | "stale_count"
  | "denied_count";

type SeriesPoint = {
  date: string;
  precision_at_budget: number | null;
  citation_coverage: number | null;
  stale_count: number | null;
  denied_count: number | null;
  run_count: number;
};

type QualityMetricsResult = {
  insufficient_data: boolean;
  run_count: number;
  series: SeriesPoint[];
  latest: Record<MetricKey, number | null>;
  latest_date: string | null;
  baseline: Record<MetricKey, number | null>;
  regression: Record<MetricKey, boolean>;
  baseline_window_days?: number;
};

type Repo = { id: string; name: string };

/** Higher-is-better vs lower-is-better governs every color & arrow on the page. */
type Direction = "up" | "down";

const RANGE_OPTS: { key: RangeKey; label: string; days: number }[] = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
];

// Decision palette (dark mode): healthy/improving green, warning amber, bad red.
const C = {
  good: "#1fd8a4",
  warn: "#f5e147",
  bad: "#ff9592",
  neutral: "#8b949e",
  grid: "var(--gray-04)",
} as const;

interface MetricMeta {
  key: MetricKey;
  label: string;
  direction: Direction;
  unit: "pct" | "count";
  help: string;
}

const METRICS: MetricMeta[] = [
  {
    key: "precision_at_budget",
    label: "Precision at budget",
    direction: "up",
    unit: "pct",
    help: "Share of the packed context that was actually relevant to the task, within the token budget. Higher is better.",
  },
  {
    key: "citation_coverage",
    label: "Citation coverage",
    direction: "up",
    unit: "pct",
    help: "Share of the work that was backed by a cited source rather than ungrounded. Higher is better.",
  },
  {
    key: "stale_count",
    label: "Stale sources",
    direction: "down",
    unit: "count",
    help: "Sources packed into context that were older than the freshness threshold. Lower is better.",
  },
  {
    key: "denied_count",
    label: "Denied sources",
    direction: "down",
    unit: "count",
    help: "Sources excluded by policy or permissions while building context. Lower is better.",
  },
];

const TICK_STYLE = {
  fill: "var(--gray-09)",
  fontSize: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} as const;

// ─── formatting helpers ──────────────────────────────────────────────────────

function fmtValue(v: number | null, unit: "pct" | "count"): string {
  if (v === null || Number.isNaN(v)) return "—";
  return unit === "pct" ? `${(v * 100).toFixed(0)}%` : `${Math.round(v)}`;
}

/** Signed delta string, e.g. "+3pp", "−12pp", "+2", "−1". */
function fmtDelta(delta: number, unit: "pct" | "count"): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const mag =
    unit === "pct"
      ? `${Math.abs(delta * 100).toFixed(0)}pp`
      : `${Math.abs(Math.round(delta))}`;
  return `${sign}${mag}`;
}

function formatDateLabel(dateStr: string): string {
  return dateStr.slice(5); // "2026-06-13" → "06-13"
}

function prettyDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return dateStr.slice(5); // month-day; the window already implies the year
}

function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

/**
 * Per-metric status: did the latest run-day improve, hold, or regress vs the
 * rolling baseline — in the direction that matters for THIS metric.
 */
type Status = "good" | "regress" | "flat" | "nobaseline";

function metricStatus(
  meta: MetricMeta,
  latest: number | null,
  baseline: number | null,
  regression: boolean
): { status: Status; delta: number | null; color: string } {
  if (latest === null || baseline === null) {
    return { status: "nobaseline", delta: null, color: C.neutral };
  }
  const delta = latest - baseline;
  if (regression) return { status: "regress", delta, color: C.bad };
  // Improvement = moving the right way for this metric's direction.
  const improving = meta.direction === "up" ? delta > 0 : delta < 0;
  if (Math.abs(delta) < (meta.unit === "pct" ? 0.005 : 0.5)) {
    return { status: "flat", delta, color: C.neutral };
  }
  return improving
    ? { status: "good", delta, color: C.good }
    : { status: "flat", delta, color: C.warn };
}

/** Auto-zoom the Y domain to the data so real variation is visible, not crushed. */
function yDomain(
  values: number[],
  unit: "pct" | "count"
): [number, number] {
  if (values.length === 0) return unit === "pct" ? [0, 1] : [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (unit === "pct") {
    const pad = 0.05;
    const lo = Math.max(0, Math.floor((min - pad) * 20) / 20);
    const hi = Math.min(1, Math.ceil((max + pad) * 20) / 20);
    return [lo, hi === lo ? Math.min(1, lo + 0.1) : hi];
  }
  // counts: always anchor at 0, headroom of 1.
  return [0, Math.max(1, Math.ceil(max + 1))];
}

/**
 * Whether a metric is actually being produced by the run pipeline. A percentage
 * metric (precision/coverage) that reads exactly 0 on every run isn't "0%
 * quality" — it means the producer never computed it, so we must not render it
 * as a real value or fold it into a green "all stable" verdict. Count metrics
 * (stale/denied) are always considered reported: 0 there is a legitimate, healthy
 * value.
 */
function isReported(
  meta: MetricMeta,
  latest: number | null,
  series: SeriesPoint[]
): boolean {
  if (meta.unit === "count") return true;
  if ((latest ?? 0) > 0) return true;
  return series.some((p) => (p[meta.key] ?? 0) > 0);
}

function deriveInitialRange(days: number): {
  rangeKey: RangeKey;
  customFrom: string;
} {
  if (days === 7) return { rangeKey: "7d", customFrom: toISO(daysAgo(7)) };
  if (days === 30) return { rangeKey: "30d", customFrom: toISO(daysAgo(30)) };
  if (days === 90) return { rangeKey: "90d", customFrom: toISO(daysAgo(90)) };
  return { rangeKey: "custom", customFrom: toISO(daysAgo(days)) };
}

// ─── KPI tile ────────────────────────────────────────────────────────────────

function KpiTile({
  meta,
  latest,
  baseline,
  regression,
  baselineWindowDays,
  runCount,
  series,
  reported,
}: {
  meta: MetricMeta;
  latest: number | null;
  baseline: number | null;
  regression: boolean;
  baselineWindowDays: number;
  runCount: number;
  series: SeriesPoint[];
  reported: boolean;
}) {
  // Not produced by the run pipeline → say so plainly, don't fake a "0%".
  if (!reported) {
    return (
      <div
        className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3"
        style={{ borderLeft: `3px solid ${C.neutral}` }}
      >
        <div className="mb-1 flex items-center gap-1">
          <span className="text-xs font-medium text-[var(--gray-11)]">
            {meta.label}
          </span>
          <span title={meta.help} className="cursor-help">
            <Info className="h-3 w-3 text-[var(--gray-08)]" />
          </span>
        </div>
        <div className="text-base font-semibold text-[var(--gray-09)]">
          Not reported
        </div>
        <div className="mt-1 text-[10px] text-[var(--gray-09)]">
          Runs aren’t emitting this metric yet.
        </div>
      </div>
    );
  }

  const { status, delta, color } = metricStatus(meta, latest, baseline, regression);
  const StatusIcon =
    status === "regress" ? AlertTriangle : status === "good" ? CheckCircle : Minus;

  // Improvement direction for the delta arrow & color.
  const improving =
    delta === null
      ? null
      : meta.direction === "up"
        ? delta > 0
        : delta < 0;
  const DeltaArrow = delta === null ? Minus : delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus;
  const deltaColor =
    improving === null ? C.neutral : improving ? C.good : C.bad;

  return (
    <div
      className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-[var(--gray-11)]">
            {meta.label}
          </span>
          <span title={meta.help} className="cursor-help">
            <Info className="h-3 w-3 text-[var(--gray-08)]" />
          </span>
        </div>
        <StatusIcon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div
            className="text-2xl font-bold leading-none tracking-tight"
            style={{ color: "var(--gray-12)" }}
          >
            {fmtValue(latest, meta.unit)}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[10px]">
            {delta === null ? (
              <span className="text-[var(--gray-09)]">
                No baseline yet ({runCount}/5 runs)
              </span>
            ) : (
              <>
                <DeltaArrow className="h-2.5 w-2.5" style={{ color: deltaColor }} />
                <span style={{ color: deltaColor }} className="font-medium">
                  {fmtDelta(delta, meta.unit)}
                </span>
                <span className="text-[var(--gray-09)]">
                  vs {baselineWindowDays}d baseline
                </span>
              </>
            )}
          </div>
        </div>

        {/* Sparkline */}
        <div className="h-9 w-24 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line
                type="monotone"
                dataKey={meta.key}
                stroke={color}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ─── Detail chart ────────────────────────────────────────────────────────────

interface TooltipPayloadEntry {
  value: number | null;
  payload: SeriesPoint;
}

function ChartTooltip({
  active,
  payload,
  label,
  meta,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  meta: MetricMeta;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]!.payload;
  const v = payload[0]!.value;
  if (v === null || point.run_count === 0) {
    return (
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1 text-[11px] text-[var(--gray-09)]">
        {label}: no runs
      </div>
    );
  }
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1 text-[11px] text-[var(--gray-12)]">
      <div className="font-medium">{label}</div>
      <div>
        {meta.label}: {fmtValue(v, meta.unit)}
      </div>
      <div className="text-[var(--gray-09)]">
        {point.run_count} run{point.run_count === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function MetricChart({
  meta,
  series,
  baseline,
  regression,
  latestDate,
  color,
  reported,
}: {
  meta: MetricMeta;
  series: SeriesPoint[];
  baseline: number | null;
  regression: boolean;
  latestDate: string | null;
  color: string;
  reported: boolean;
}) {
  const values = series
    .map((p) => p[meta.key])
    .filter((v): v is number => v !== null);
  const domain = yDomain(baseline !== null ? [...values, baseline] : values, meta.unit);

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-[var(--gray-11)]">{meta.label}</p>
        <span className="text-[10px] text-[var(--gray-09)]">
          {meta.direction === "up" ? "higher is better" : "lower is better"}
        </span>
      </div>
      {!reported ? (
        <div
          style={{ height: 140 }}
          className="flex flex-col items-center justify-center gap-1 text-center"
        >
          <p className="text-xs text-[var(--gray-09)]">Not reported yet</p>
          <p className="max-w-[18rem] text-[10px] text-[var(--gray-08)]">
            The run pipeline isn’t emitting {meta.label.toLowerCase()} — every run
            reports 0. This is a producer gap, not a measured value.
          </p>
        </div>
      ) : (
      <div style={{ height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="2 2" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateLabel}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={38}
              domain={domain}
              allowDecimals={meta.unit === "count" ? false : true}
              tickFormatter={(v: number) => fmtValue(v, meta.unit)}
            />
            <Tooltip
              cursor={{ stroke: "var(--gray-06)", strokeWidth: 1 }}
              content={(props) => (
                <ChartTooltip {...(props as object)} meta={meta} />
              )}
            />
            {baseline !== null && (
              <ReferenceLine
                y={baseline}
                stroke="var(--gray-08)"
                strokeDasharray="4 2"
                label={{
                  value: "baseline",
                  position: "insideTopRight",
                  fill: "var(--gray-09)",
                  fontSize: 9,
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              />
            )}
            <Line
              type="monotone"
              dataKey={meta.key}
              stroke={regression ? C.bad : color}
              strokeWidth={1.5}
              connectNulls
              isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; payload?: SeriesPoint }) => {
                const { cx, cy, payload } = props;
                // Only mark days that actually had runs.
                if (cx == null || cy == null || !payload || payload.run_count === 0) {
                  return <g key={`${cx}-${cy}`} />;
                }
                return (
                  <circle
                    key={`${cx}-${cy}`}
                    cx={cx}
                    cy={cy}
                    r={2.5}
                    fill={regression ? C.bad : color}
                  />
                );
              }}
              activeDot={{ r: 3.5, fill: regression ? C.bad : color }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      )}
      {reported && regression && latestDate && (
        <p className="mt-1.5 text-[10px] text-[#ff9592]">
          Regressed below baseline on {prettyDate(latestDate)}.
        </p>
      )}
    </div>
  );
}

// ─── Page client ─────────────────────────────────────────────────────────────

export function QualityChartsClient({
  workspaceId,
  baselineWindowDays,
}: {
  workspaceId: string;
  baselineWindowDays: number;
}) {
  const initial = deriveInitialRange(baselineWindowDays);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repositoryId, setRepositoryId] = useState<string>("");
  const [rangeKey, setRangeKey] = useState<RangeKey>(initial.rangeKey);
  const [customFrom, setCustomFrom] = useState(initial.customFrom);
  const [customTo, setCustomTo] = useState(toISO(new Date()));
  const [result, setResult] = useState<QualityMetricsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Notices (no-signal / baseline-forming) are dismissible and stay dismissed
  // per workspace — an explanatory banner shouldn't nag on every visit.
  const noticeKey = `cq-notice-dismissed:${workspaceId}`;
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  useEffect(() => {
    try {
      setNoticeDismissed(localStorage.getItem(noticeKey) === "1");
    } catch {
      // localStorage unavailable — leave the notice visible
    }
  }, [noticeKey]);
  function dismissNotice() {
    setNoticeDismissed(true);
    try {
      localStorage.setItem(noticeKey, "1");
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/repos`)
      .then((r) => r.json())
      .then((json: { repos?: Repo[] }) => setRepos(json.repos ?? []))
      .catch(() => {});
  }, [workspaceId]);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(
        `/api/v1/workspaces/${workspaceId}/context-quality/metrics`,
        window.location.origin
      );

      if (repositoryId) url.searchParams.set("repositoryId", repositoryId);

      let windowDays: number;
      let from: string;
      let to: string;

      if (rangeKey === "custom") {
        from = customFrom;
        to = customTo;
        const diffMs = new Date(to).getTime() - new Date(from).getTime();
        windowDays = Math.max(7, Math.min(90, Math.round(diffMs / 86400000)));
      } else {
        const days = RANGE_OPTS.find((r) => r.key === rangeKey)?.days ?? 30;
        windowDays = days;
        to = toISO(new Date());
        from = toISO(daysAgo(days));
      }

      url.searchParams.set("windowDays", String(windowDays));
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setResult((await res.json()) as QualityMetricsResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load quality metrics");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, repositoryId, rangeKey, customFrom, customTo]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const windowDaysLabel =
    rangeKey === "custom"
      ? `${customFrom} → ${customTo}`
      : RANGE_OPTS.find((r) => r.key === rangeKey)?.label ?? "30d";

  const reportedByKey: Record<MetricKey, boolean> = {
    precision_at_budget: true,
    citation_coverage: true,
    stale_count: true,
    denied_count: true,
  };
  if (result) {
    for (const m of METRICS) {
      reportedByKey[m.key] = isReported(m, result.latest[m.key], result.series);
    }
  }
  const regressingCount = result
    ? METRICS.filter((m) => result.regression[m.key]).length
    : 0;
  // The two quality percentages are the headline signal. If neither is being
  // produced, the page must not flash a green "all stable" — that's a lie.
  const pctMetrics = METRICS.filter((m) => m.unit === "pct");
  const noQualitySignal =
    !!result &&
    result.run_count > 0 &&
    pctMetrics.every((m) => !reportedByKey[m.key]);

  return (
    <div className="flex flex-col gap-5">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={repositoryId}
          onChange={(e) => setRepositoryId(e.target.value)}
          className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-xs text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
        >
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <div className="flex gap-1">
          {RANGE_OPTS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setRangeKey(key)}
              className={`h-8 rounded px-3 text-xs transition-colors duration-150 ${
                rangeKey === key
                  ? "bg-[var(--gray-04)] text-[var(--gray-12)]"
                  : "text-[var(--gray-09)] hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setRangeKey("custom")}
            className={`h-8 rounded px-3 text-xs transition-colors duration-150 ${
              rangeKey === "custom"
                ? "bg-[var(--gray-04)] text-[var(--gray-12)]"
                : "text-[var(--gray-09)] hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
            }`}
          >
            Custom
          </button>
        </div>

        {rangeKey === "custom" && (
          <>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-xs text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
            />
            <span className="text-xs text-[var(--gray-09)]">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-xs text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
            />
          </>
        )}
      </div>

      {error && <p className="py-4 text-center text-sm text-[#ff9592]">{error}</p>}

      {/* Loading */}
      {loading && !error && (
        <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3"
            >
              <Skeleton className="mb-2 h-3 w-24" />
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && result && (
        <>
          {/* Health summary banner */}
          {result.run_count === 0 ? (
            <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-6 py-8 text-center">
              <p className="text-sm text-[var(--gray-11)]">
                No context packs recorded in this window.
              </p>
              <p className="mt-1 text-xs text-[var(--gray-09)]">
                Runs that build a context pack will appear here once they start
                reporting.
              </p>
            </div>
          ) : (
            <>
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2"
                style={{
                  borderColor:
                    regressingCount > 0
                      ? "rgba(255,149,146,0.4)"
                      : noQualitySignal
                        ? "rgba(245,225,71,0.3)"
                        : "rgba(31,216,164,0.3)",
                  background:
                    regressingCount > 0
                      ? "rgba(59,15,16,0.5)"
                      : noQualitySignal
                        ? "rgba(31,26,8,0.5)"
                        : "rgba(12,36,23,0.5)",
                }}
              >
                <div className="flex items-center gap-2">
                  {regressingCount > 0 ? (
                    <AlertTriangle className="h-4 w-4 text-[#ff9592]" />
                  ) : noQualitySignal || result.insufficient_data ? (
                    <Info className="h-4 w-4 text-[var(--gray-09)]" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-[#1fd8a4]" />
                  )}
                  <span className="text-xs font-medium text-[var(--gray-12)]">
                    {regressingCount > 0
                      ? `${regressingCount} of 4 metrics regressing`
                      : noQualitySignal
                        ? "Quality signal not reported yet"
                        : result.insufficient_data
                          ? "Baseline forming"
                          : "All metrics stable"}
                  </span>
                </div>
                <span className="text-[11px] text-[var(--gray-09)]">
                  {result.run_count} run{result.run_count === 1 ? "" : "s"} ·{" "}
                  {windowDaysLabel} · latest {prettyDate(result.latest_date)}
                </span>
              </div>

              {/* No-quality-signal notice — the producer isn't emitting precision/coverage */}
              {noQualitySignal && !noticeDismissed && (
                <div className="flex items-start gap-2 rounded border border-[rgba(245,225,71,0.3)] bg-[rgba(31,26,8,0.5)] px-3 py-2 text-[11px] text-[#f5e147]">
                  <span className="flex-1">
                    {result.run_count} runs recorded, but precision &amp; citation
                    coverage are 0 on every one — the run pipeline isn’t computing
                    them yet. Counts below are shown; the percentages are a producer
                    gap, not measured quality.
                  </span>
                  <button
                    onClick={dismissNotice}
                    aria-label="Dismiss"
                    className="-mr-1 shrink-0 rounded p-0.5 text-[#f5e147]/70 transition-colors hover:bg-[rgba(245,225,71,0.15)] hover:text-[#f5e147]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* Insufficient-data notice (graceful, not a wall) */}
              {result.insufficient_data && !noQualitySignal && !noticeDismissed && (
                <div className="flex items-start gap-2 rounded border border-[rgba(245,225,71,0.3)] bg-[rgba(31,26,8,0.5)] px-3 py-2 text-[11px] text-[#f5e147]">
                  <span className="flex-1">
                    Showing the {result.run_count} run
                    {result.run_count === 1 ? "" : "s"} recorded so far. Trend
                    baselines and regression alerts unlock at 5 runs in the window.
                  </span>
                  <button
                    onClick={dismissNotice}
                    aria-label="Dismiss"
                    className="-mr-1 shrink-0 rounded p-0.5 text-[#f5e147]/70 transition-colors hover:bg-[rgba(245,225,71,0.15)] hover:text-[#f5e147]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* KPI tiles */}
              <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
                {METRICS.map((meta) => (
                  <KpiTile
                    key={meta.key}
                    meta={meta}
                    latest={result.latest[meta.key]}
                    baseline={result.baseline[meta.key]}
                    regression={result.regression[meta.key]}
                    baselineWindowDays={result.baseline_window_days ?? baselineWindowDays}
                    runCount={result.run_count}
                    series={result.series}
                    reported={reportedByKey[meta.key]}
                  />
                ))}
              </div>

              {/* Detail charts */}
              <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                {METRICS.map((meta) => {
                  const color = meta.direction === "up" ? C.good : C.warn;
                  return (
                    <MetricChart
                      key={meta.key}
                      meta={meta}
                      series={result.series}
                      baseline={result.baseline[meta.key]}
                      regression={result.regression[meta.key]}
                      latestDate={result.latest_date}
                      color={color}
                      reported={reportedByKey[meta.key]}
                    />
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* Rot Score Card — always shown; re-fetches when repositoryId changes */}
      <RotScoreCard workspaceId={workspaceId} repositoryId={repositoryId} />
    </div>
  );
}
