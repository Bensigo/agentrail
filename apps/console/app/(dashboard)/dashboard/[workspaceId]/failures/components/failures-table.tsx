"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";
import { nameOrShortId } from "../../../../../components/id-display";

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
  repositories: { id: string; name: string }[];
  initialRunId?: string;
}

type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "";

const TIME_RANGES: { label: string; value: TimeRange }[] = [
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
    className: "bg-[var(--red-09)]/20 text-[var(--red-11)] border border-[var(--red-09)]/30",
  },
  high: {
    label: "high",
    className: "bg-[var(--orange-09)]/20 text-[var(--orange-11)] border border-[var(--orange-09)]/30",
  },
  medium: {
    label: "medium",
    className: "bg-[var(--yellow-09)]/20 text-[var(--severity-medium-text)] border border-[var(--yellow-09)]/30",
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

function buildColumns(
  workspaceId: string,
  repoNames: Record<string, string>
) {
  return [
    columnHelper.accessor("severity", {
      header: "Severity",
      cell: (info) => <SeverityBadge severity={info.getValue()} />,
    }),
    columnHelper.accessor("failure_type", {
      header: "Type",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-11)]">
          {info.getValue()}
        </span>
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
      cell: (info) => {
        const id = info.getValue();
        const { text, title } = nameOrShortId(repoNames[id], id);
        return (
          <span className="text-[var(--gray-11)] text-xs" title={title}>
            {text}
          </span>
        );
      },
    }),
    columnHelper.accessor("phase", {
      header: "Phase",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-10)]">
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("run_id", {
      header: "Run",
      cell: (info) => (
        <a
          href={`/dashboard/${workspaceId}/failures?run_id=${info.getValue()}`}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-xs text-[var(--gray-11)] hover:text-[var(--yellow-09)] transition-colors"
        >
          {info.getValue().slice(0, 8)}
        </a>
      ),
    }),
    columnHelper.accessor("occurred_at", {
      header: "When",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-10)]">
          {formatOccurredAt(info.getValue())}
        </span>
      ),
    }),
  ];
}

export function FailuresTable({
  workspaceId,
  repositories,
  initialRunId,
}: FailuresTableProps) {
  const router = useRouter();
  const [data, setData] = useState<FailureRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [repoId, setRepoId] = useState("");
  const [severity, setSeverity] = useState("");
  const [failureType, setFailureType] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("");

  const repoNames = Object.fromEntries(
    repositories.map((r) => [r.id, r.name])
  );
  const columns = buildColumns(workspaceId, repoNames);

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

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)]"
        >
          <option value="">All repos</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)]"
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
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)]"
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
              key={value}
              onClick={() =>
                setTimeRange((prev) => (prev === value ? "" : value))
              }
              className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
                timeRange === value
                  ? "bg-[var(--yellow-09)] text-black border-[var(--yellow-09)]"
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

      {/* Table */}
      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {table.getFlatHeaders().map((header) => (
                <th
                  key={header.id}
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonTableRows columns={columns.length} rows={8} />
            ) : error ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-sm text-[var(--red-11)]"
                >
                  {error}
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  No failures found
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() =>
                    router.push(
                      `/dashboard/${workspaceId}/failures/${row.original.event_id}`
                    )
                  }
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] cursor-pointer transition-colors"
                  style={{ height: "34px" }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-1.5">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
