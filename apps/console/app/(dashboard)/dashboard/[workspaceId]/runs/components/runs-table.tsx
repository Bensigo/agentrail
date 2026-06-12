"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { StatusBadge } from "./status-badge";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";

export interface RunRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  agent: string;
  branch: string;
  title: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  duration: number | null;
  failure_count: number;
  total_cost: number;
}

interface RunsTableProps {
  workspaceId: string;
  repositories: string[];
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

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatStartedAt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const columnHelper = createColumnHelper<RunRecord>();

const columns = [
  columnHelper.accessor("title", {
    header: "Feature",
    cell: (info) => (
      <span className="font-medium">{info.getValue() || "—"}</span>
    ),
  }),
  columnHelper.accessor("id", {
    header: "Run ID",
    cell: (info) => (
      <span className="font-mono text-[var(--gray-12)]">
        {info.getValue().slice(0, 8)}
      </span>
    ),
  }),
  columnHelper.accessor("repositoryId", {
    header: "Repo",
    cell: (info) => (
      <span className="text-[var(--gray-11)]">{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor("branch", {
    header: "Branch",
    cell: (info) => (
      <span className="font-mono text-[var(--gray-10)] text-xs">
        {info.getValue() || "—"}
      </span>
    ),
  }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => <StatusBadge status={info.getValue()} />,
  }),
  columnHelper.accessor("agent", {
    header: "Agent",
    cell: (info) => (
      <span className="text-[var(--gray-11)]">{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor("startedAt", {
    header: "Started",
    cell: (info) => (
      <span className="font-mono text-[var(--gray-10)] text-xs">
        {formatStartedAt(info.getValue())}
      </span>
    ),
  }),
  columnHelper.accessor("duration", {
    header: "Duration",
    cell: (info) => (
      <span className="font-mono text-[var(--gray-10)] text-xs">
        {formatDuration(info.getValue())}
      </span>
    ),
  }),
  columnHelper.accessor("total_cost", {
    header: "Cost",
    cell: () => (
      <span className="font-mono text-[var(--gray-10)] text-xs">—</span>
    ),
  }),
];

export function RunsTable({ workspaceId, repositories }: RunsTableProps) {
  const router = useRouter();
  const [data, setData] = useState<RunRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState("");
  const [repoId, setRepoId] = useState("");
  const [timeRange, setTimeRange] = useState<TimeRange>("");

  const fetchRuns = useCallback(
    async (cursor?: string, append = false) => {
      if (!append) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const url = new URL(
          `/api/v1/workspaces/${workspaceId}/runs`,
          window.location.origin
        );
        if (status) url.searchParams.set("status", status);
        if (repoId) url.searchParams.set("repository_id", repoId);
        if (timeRange) {
          const from = timeRangeToFrom(timeRange);
          if (from) url.searchParams.set("time_from", from.toISOString());
        }
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          runs: RunRecord[];
          nextCursor: string | null;
        };
        setData((prev) => (append ? [...prev, ...json.runs] : json.runs));
        setNextCursor(json.nextCursor ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load runs");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [workspaceId, status, repoId, timeRange]
  );

  useEffect(() => {
    fetchRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilters = () => fetchRuns();
  const loadMore = () => {
    if (nextCursor) fetchRuns(nextCursor, true);
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
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
        >
          <option value="">All statuses</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
        </select>

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

        <div className="flex items-center gap-1">
          {TIME_RANGES.map(({ label, value }) => (
            <button
              key={value}
              onClick={() =>
                setTimeRange((prev) => (prev === value ? "" : value))
              }
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
                  className="px-3 py-8 text-center text-sm text-[#ff9592]"
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
                  No runs found
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() =>
                    router.push(
                      `/dashboard/${workspaceId}/runs/${row.original.id}`
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
