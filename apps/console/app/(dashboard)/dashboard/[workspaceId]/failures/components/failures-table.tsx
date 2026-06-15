"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../../../components/data-table";
import { StatHeader } from "../../../../components/stat-header";

export interface FailureRecord {
  event_id: string;
  workspace_id: string;
  run_id: string;
  repository_id: string;
  failure_type: string;
  message: string;
  evidence: string;
  phase: string;
  severity: string;
  occurred_at: string;
}

interface FailuresTableProps {
  workspaceId: string;
  repositories: string[];
  initialRunId?: string;
}

type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "";

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: "All", value: "" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

function timeRangeToFrom(range: TimeRange): Date | undefined {
  if (!range) return undefined;
  const now = new Date();
  const ms: Record<string, number> = {
    "1h": 1 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(now.getTime() - ms[range]);
}

function formatOccurredAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type Severity = "critical" | "high" | "medium" | "low";

const severityConfig: Record<Severity, { label: string; className: string }> = {
  critical: {
    label: "critical",
    className: "bg-[#e5484d]/20 text-[#ff9592] border border-[#e5484d]/30",
  },
  high: {
    label: "high",
    className: "bg-[#f76b15]/20 text-[#ffa057] border border-[#f76b15]/30",
  },
  medium: {
    label: "medium",
    className: "bg-[#ffe629]/20 text-[#f5d90a] border border-[#ffe629]/30",
  },
  low: {
    label: "low",
    className:
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
  },
};

function SeverityBadge({ severity }: { severity: string }) {
  const config = severityConfig[severity as Severity] ?? {
    label: severity,
    className:
      "bg-[var(--gray-04)] text-[var(--gray-10)] border border-[var(--gray-06)]",
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}

const columnHelper = createColumnHelper<FailureRecord>();

function buildColumns(workspaceId: string): ColumnDef<FailureRecord, unknown>[] {
  return [
    columnHelper.accessor("occurred_at", {
      header: "When",
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-10)]">
          {formatOccurredAt(info.getValue())}
        </span>
      ),
    }),
    columnHelper.accessor("run_id", {
      header: "Run",
      meta: { mono: true },
      cell: (info) => (
        <a
          href={`/dashboard/${workspaceId}/runs/${info.getValue()}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[var(--gray-11)] hover:text-[#ffe629] transition-colors"
        >
          {info.getValue().slice(0, 8)}
        </a>
      ),
    }),
    columnHelper.accessor("severity", {
      header: "Severity",
      cell: (info) => <SeverityBadge severity={info.getValue()} />,
    }),
    columnHelper.accessor("failure_type", {
      header: "Type",
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-11)]">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor("message", {
      header: "Message",
      cell: (info) => (
        <span className="text-[var(--gray-12)] truncate max-w-[360px] block">
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("repository_id", {
      header: "Repo",
      cell: (info) => (
        <span className="text-[var(--gray-11)] text-xs">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor("phase", {
      header: "Phase",
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-10)]">{info.getValue()}</span>
      ),
    }),
  ] as ColumnDef<FailureRecord, unknown>[];
}

export function FailuresTable({
  workspaceId,
  repositories,
  initialRunId,
}: FailuresTableProps) {
  const [data, setData] = useState<FailureRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repoId, setRepoId] = useState("");
  const [severity, setSeverity] = useState("");
  const [failureType, setFailureType] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("");

  const columns = useMemo(() => buildColumns(workspaceId), [workspaceId]);

  const fetchFailures = useCallback(
    async (cursor?: string, append = false) => {
      if (!append) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const url = new URL(
          `/api/v1/workspaces/${workspaceId}/failures`,
          window.location.origin
        );
        if (repoId) url.searchParams.set("repository_id", repoId);
        if (severity) url.searchParams.set("severity", severity);
        if (failureType) url.searchParams.set("failure_type", failureType);
        if (initialRunId) url.searchParams.set("run_id", initialRunId);
        if (timeRange) {
          const from = timeRangeToFrom(timeRange);
          if (from) url.searchParams.set("time_from", from.toISOString());
        }
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as {
          failures: FailureRecord[];
          nextCursor: string | null;
        };
        setData((prev) => (append ? [...prev, ...json.failures] : json.failures));
        setNextCursor(json.nextCursor ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load failures");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [workspaceId, repoId, severity, failureType, timeRange, initialRunId]
  );

  useEffect(() => {
    fetchFailures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () => fetchFailures();
  const loadMore = () => {
    if (nextCursor) fetchFailures(nextCursor, true);
  };

  const critical = data.filter((f) => f.severity === "critical").length;
  const high = data.filter((f) => f.severity === "high").length;
  const medium = data.filter((f) => f.severity === "medium").length;
  const low = data.filter((f) => f.severity === "low").length;

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={repoId}
        onChange={(e) => setRepoId(e.target.value)}
        className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
      >
        <option value="">All repos</option>
        {repositories.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      <select
        value={severity}
        onChange={(e) => setSeverity(e.target.value)}
        className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
      >
        <option value="">All severities</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>

      <select
        value={failureType}
        onChange={(e) => setFailureType(e.target.value)}
        className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
      >
        <option value="">All types</option>
        <option value="tool_error">tool_error</option>
        <option value="context_error">context_error</option>
        <option value="auth_error">auth_error</option>
        <option value="lint_error">lint_error</option>
        <option value="test_error">test_error</option>
        <option value="build_error">build_error</option>
      </select>

      <div className="flex items-center gap-1">
        {TIME_RANGES.map(({ label, value }) => (
          <button
            key={value || "all"}
            onClick={() => setTimeRange(value)}
            className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
              timeRange === value
                ? "bg-[#ffe629] text-black border-[#ffe629]"
                : "bg-[var(--gray-02)] text-[var(--gray-11)] border-[var(--gray-05)] hover:border-[var(--gray-08)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        onClick={applyFilters}
        className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
      >
        Apply
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {!loading && !error && (
        <StatHeader
          stats={[
            { label: "Total", value: data.length },
            { label: "Critical", value: critical, color: "red" },
            { label: "High", value: high, color: "orange" },
            { label: "Medium", value: medium, color: "yellow" },
            { label: "Low", value: low, color: "gray" },
          ]}
        />
      )}
      <DataTable
        columns={columns}
        data={data}
        loading={loading}
        error={error}
        emptyMessage="No failures found."
        filterBar={filterBar}
        onRetry={() => fetchFailures()}
      />
      {nextCursor && !loading && (
        <div className="flex justify-center pt-1">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="h-8 px-4 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-50 transition-colors"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
