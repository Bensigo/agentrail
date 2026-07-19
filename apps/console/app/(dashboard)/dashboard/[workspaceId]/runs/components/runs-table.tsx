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
import { shortId, nameOrShortId } from "../../../../../components/id-display";

export interface RunRecord {
  id: string;
  workspaceId: string;
  repositoryId: string;
  repository_name: string | null;
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
  tokens_saved: number;
  pr_url: string | null;
}

interface RepoOption {
  id: string;
  name: string;
}

interface RunsTableProps {
  workspaceId: string;
  repositories: RepoOption[];
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

function formatTokens(n: number): string {
  if (n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
    // font-normal: this cell is a peer among equals in a dense row (Repo,
    // Branch, Agent, etc. are all unweighted) — no single column earns
    // emphasis over another per TASTE.md's Data Table pattern.
    cell: (info) => (
      <span className="font-normal">{info.getValue() || "—"}</span>
    ),
  }),
  columnHelper.accessor("id", {
    header: "Run ID",
    cell: (info) => (
      <span
        className="font-mono text-[var(--gray-12)]"
        title={info.getValue()}
      >
        {shortId(info.getValue())}
      </span>
    ),
  }),
  columnHelper.accessor("repository_name", {
    header: "Repo",
    cell: (info) => {
      const { text, title } = nameOrShortId(
        info.getValue(),
        info.row.original.repositoryId
      );
      return (
        <span className="text-[var(--gray-11)]" title={title}>
          {text}
        </span>
      );
    },
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
  columnHelper.accessor("pr_url", {
    header: "PR",
    cell: (info) => {
      const url = info.getValue();
      if (!url) return <span className="text-[var(--gray-08)]">—</span>;
      const m = url.match(/\/pull\/(\d+)/);
      const label = m ? `#${m[1]}` : "PR";
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[var(--blue-11)] hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </a>
      );
    },
  }),
  columnHelper.accessor("agent", {
    header: "Agent",
    // font-mono: agent is the executor engine slug (e.g. "claude"), same
    // field rendered font-mono on the context-pack page's engine tag.
    cell: (info) => (
      <span className="font-mono text-xs text-[var(--gray-11)]">{info.getValue()}</span>
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
    cell: (info) => {
      const cost = info.getValue();
      return (
        <span className="font-mono text-[var(--gray-10)] text-xs">
          {cost > 0 ? `$${cost.toFixed(4)}` : "—"}
        </span>
      );
    },
  }),
  columnHelper.accessor("tokens_saved", {
    header: "Tokens saved",
    cell: (info) => {
      const saved = info.getValue();
      return (
        <span
          className="font-mono text-xs text-[var(--green-11)]"
          title="Context retrieval + cache reads"
        >
          {formatTokens(saved)}
        </span>
      );
    },
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
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)]"
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
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)]"
        >
          <option value="">All repos</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {/* font-normal: weight is uniform across active/inactive states
              here (color carries the "active" signal), so this isn't a
              font-medium active-state case — matches the sibling
              Apply/Load-more buttons, which use no weight override. */}
          {TIME_RANGES.map(({ label, value }) => (
            <button
              key={value}
              onClick={() =>
                setTimeRange((prev) => (prev === value ? "" : value))
              }
              className={`h-8 px-2.5 rounded text-xs font-normal border transition-colors ${
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
