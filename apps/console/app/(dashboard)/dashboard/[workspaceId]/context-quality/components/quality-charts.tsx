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
import { AlertTriangle, CheckCircle } from "lucide-react";
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
  precision_at_budget: number;
  citation_coverage: number;
  stale_count: number;
  denied_count: number;
};

type QualityMetricsResult =
  | { insufficient_data: true }
  | {
      insufficient_data: false;
      series: SeriesPoint[];
      baseline: Record<MetricKey, number>;
      regression: Record<MetricKey, boolean>;
    };

type Repo = { id: string; name: string };

const RANGE_OPTS: { key: RangeKey; label: string; days: number }[] = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
];

const METRICS: {
  key: MetricKey;
  label: string;
  color: string;
  formatY: (v: number) => string;
}[] = [
  {
    key: "precision_at_budget",
    label: "Precision at budget",
    color: "#1fd8a4",
    formatY: (v) => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "citation_coverage",
    label: "Citation coverage",
    color: "#1fd8a4",
    formatY: (v) => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "stale_count",
    label: "Stale sources",
    color: "#f5e147",
    formatY: (v) => Math.round(v).toString(),
  },
  {
    key: "denied_count",
    label: "Denied sources",
    color: "#ff9592",
    formatY: (v) => Math.round(v).toString(),
  },
];

const TICK_STYLE = {
  fill: "var(--gray-09)",
  fontSize: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} as const;

function formatDateLabel(dateStr: string): string {
  // "2026-06-13" → "06-13"
  return dateStr.slice(5);
}

function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

interface MetricChartProps {
  label: string;
  color: string;
  metricKey: MetricKey;
  series: SeriesPoint[];
  baseline: number;
  formatY: (v: number) => string;
}

function MetricChart({
  label,
  color,
  metricKey,
  series,
  baseline,
  formatY,
}: MetricChartProps) {
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
      <p className="mb-2 text-xs font-medium text-[var(--gray-11)]">{label}</p>
      <div style={{ height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={series}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              stroke="var(--gray-04)"
              strokeDasharray="2 2"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tickFormatter={formatDateLabel}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={38}
              tickFormatter={(v: number) => formatY(v)}
            />
            <Tooltip
              contentStyle={{
                background: "var(--gray-02)",
                border: "1px solid var(--gray-05)",
                borderRadius: 4,
                fontSize: 11,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: "var(--gray-12)",
              }}
            />
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
            <Line
              type="monotone"
              dataKey={metricKey}
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: color }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function QualityChartsClient({ workspaceId }: { workspaceId: string }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repositoryId, setRepositoryId] = useState<string>("");
  const [rangeKey, setRangeKey] = useState<RangeKey>("30d");
  const [customFrom, setCustomFrom] = useState(toISO(daysAgo(30)));
  const [customTo, setCustomTo] = useState(toISO(new Date()));
  const [result, setResult] = useState<QualityMetricsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        const diffMs =
          new Date(to).getTime() - new Date(from).getTime();
        windowDays = Math.max(7, Math.min(90, Math.round(diffMs / 86400000)));
      } else {
        const days =
          RANGE_OPTS.find((r) => r.key === rangeKey)?.days ?? 30;
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
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      setResult((await res.json()) as QualityMetricsResult);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load quality metrics"
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId, repositoryId, rangeKey, customFrom, customTo]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  return (
    <div className="flex flex-col gap-6">
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

      {/* Error */}
      {error && (
        <p className="py-4 text-center text-sm text-[#ff9592]">{error}</p>
      )}

      {/* Loading skeleton */}
      {loading && !error && (
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3"
            >
              <Skeleton className="mb-2 h-3 w-32" />
              <Skeleton className="h-[140px] w-full" />
            </div>
          ))}
        </div>
      )}

      {/* Insufficient data */}
      {!loading && !error && result?.insufficient_data === true && (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-6 py-8 text-center">
          <p className="text-sm text-[var(--gray-09)]">
            Insufficient data — fewer than 5 runs in the selected window.
          </p>
        </div>
      )}

      {/* Regression badges + charts */}
      {!loading && !error && result && !result.insufficient_data && (
        <>
          <div className="flex flex-wrap gap-2">
            {METRICS.map(({ key, label }) => {
              const regressing = result.regression[key];
              return (
                <span
                  key={key}
                  className={`flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium ${
                    regressing
                      ? "bg-[#3b0f10] text-[#ff9592]"
                      : "bg-[#0c2417] text-[#1fd8a4]"
                  }`}
                >
                  {regressing ? (
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                  ) : (
                    <CheckCircle className="h-3 w-3 shrink-0" />
                  )}
                  {label}: {regressing ? "Regression detected" : "Stable"}
                </span>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            {METRICS.map(({ key, label, color, formatY }) => (
              <MetricChart
                key={key}
                label={label}
                color={color}
                metricKey={key}
                series={result.series}
                baseline={result.baseline[key]}
                formatY={formatY}
              />
            ))}
          </div>
        </>
      )}

      {/* Rot Score Card — always shown; re-fetches when repositoryId changes */}
      <RotScoreCard workspaceId={workspaceId} repositoryId={repositoryId} />
    </div>
  );
}
