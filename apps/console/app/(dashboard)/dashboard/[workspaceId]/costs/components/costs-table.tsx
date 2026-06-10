"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnDef,
} from "@tanstack/react-table";
import { SkeletonTableRows } from "../../../../../components/loading-skeleton";

export interface CostRow {
  entity_id: string;
  total_tokens: number;
  total_cost_usd: number;
  model_call_tokens: number;
  model_call_cost_usd: number;
  embedding_tokens: number;
  embedding_cost_usd: number;
  reranking_tokens: number;
  reranking_cost_usd: number;
  storage_tokens: number;
  storage_cost_usd: number;
  event_count: number;
}

type GroupBy = "team" | "repo" | "api_key" | "run";
type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "";

interface CostsTableProps {
  workspaceId: string;
}

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

const GROUP_BY_OPTIONS: { label: string; value: GroupBy }[] = [
  { label: "Repo", value: "repo" },
  { label: "Team", value: "team" },
  { label: "API Key", value: "api_key" },
  { label: "Run", value: "run" },
];

const GROUP_LABEL: Record<GroupBy, string> = {
  repo: "Repository",
  team: "Team",
  api_key: "API Key",
  run: "Run ID",
};

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

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function SortIcon({ dir }: { dir: "asc" | "desc" | false }) {
  if (!dir) return <span className="ml-0.5 text-[var(--gray-07)]">↕</span>;
  return (
    <span className="ml-0.5 text-[#ffe629]">{dir === "asc" ? "↑" : "↓"}</span>
  );
}

const columnHelper = createColumnHelper<CostRow>();

function buildColumns(groupBy: GroupBy): ColumnDef<CostRow, unknown>[] {
  return [
    columnHelper.accessor("entity_id", {
      id: "entity_id",
      header: GROUP_LABEL[groupBy],
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-12)] truncate max-w-[200px] block">
          {info.getValue() || "—"}
        </span>
      ),
    }),
    columnHelper.accessor("total_tokens", {
      id: "total_tokens",
      header: "Total tokens",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-11)]">
          {fmtTokens(info.getValue() as number)}
        </span>
      ),
    }),
    columnHelper.accessor("total_cost_usd", {
      id: "total_cost_usd",
      header: "Total cost",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-12)] font-medium">
          {fmtCost(info.getValue() as number)}
        </span>
      ),
    }),
    columnHelper.accessor("model_call_cost_usd", {
      id: "model_call_cost_usd",
      header: "Model calls",
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="font-mono text-xs text-[var(--gray-11)]">
            {fmtCost(info.getValue() as number)}{" "}
            <span className="text-[var(--gray-09)]">
              ({fmtTokens(row.model_call_tokens)})
            </span>
          </span>
        );
      },
    }),
    columnHelper.accessor("embedding_cost_usd", {
      id: "embedding_cost_usd",
      header: "Embeddings",
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="font-mono text-xs text-[var(--gray-11)]">
            {fmtCost(info.getValue() as number)}{" "}
            <span className="text-[var(--gray-09)]">
              ({fmtTokens(row.embedding_tokens)})
            </span>
          </span>
        );
      },
    }),
    columnHelper.accessor("reranking_cost_usd", {
      id: "reranking_cost_usd",
      header: "Reranking",
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="font-mono text-xs text-[var(--gray-11)]">
            {fmtCost(info.getValue() as number)}{" "}
            <span className="text-[var(--gray-09)]">
              ({fmtTokens(row.reranking_tokens)})
            </span>
          </span>
        );
      },
    }),
    columnHelper.accessor("storage_cost_usd", {
      id: "storage_cost_usd",
      header: "Storage",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-11)]">
          {fmtCost(info.getValue() as number)}
        </span>
      ),
    }),
    columnHelper.accessor("event_count", {
      id: "event_count",
      header: "Events",
      cell: (info) => (
        <span className="font-mono text-xs text-[var(--gray-10)]">
          {(info.getValue() as number).toLocaleString()}
        </span>
      ),
    }),
  ] as ColumnDef<CostRow, unknown>[];
}

export function CostsTable({ workspaceId }: CostsTableProps) {
  const [data, setData] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("repo");
  const [timeRange, setTimeRange] = useState<TimeRange>("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "total_cost_usd", desc: true },
  ]);

  const columns = useMemo(() => buildColumns(groupBy), [groupBy]);

  const fetchCosts = useCallback(
    async (gb: GroupBy, tr: TimeRange) => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL(
          `/api/v1/workspaces/${workspaceId}/costs`,
          window.location.origin
        );
        url.searchParams.set("group_by", gb);
        if (tr) {
          const from = timeRangeToFrom(tr);
          if (from) url.searchParams.set("time_from", from.toISOString());
        }
        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as { costs: CostRow[] };
        setData(json.costs);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load cost data");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    fetchCosts(groupBy, timeRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGroupByChange = (gb: GroupBy) => {
    setGroupBy(gb);
    fetchCosts(gb, timeRange);
  };

  const handleTimeRangeToggle = (tr: TimeRange) => {
    const next = timeRange === tr ? "" : tr;
    setTimeRange(next);
    fetchCosts(groupBy, next);
  };

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualSorting: false,
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Group-by selector */}
        <div className="flex items-center gap-1">
          {GROUP_BY_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => handleGroupByChange(value)}
              className={`h-8 px-2.5 rounded text-xs font-medium border transition-colors ${
                groupBy === value
                  ? "bg-[#ffe629] text-black border-[#ffe629]"
                  : "bg-[var(--gray-02)] text-[var(--gray-11)] border-[var(--gray-05)] hover:border-[var(--gray-08)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-[var(--gray-05)]" />

        {/* Time range buttons */}
        <div className="flex items-center gap-1">
          {TIME_RANGES.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => handleTimeRangeToggle(value)}
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
      </div>

      {/* Table */}
      <div className="rounded border border-[var(--gray-05)] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              {table.getFlatHeaders().map((header) => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className={`px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] select-none ${
                    header.column.getCanSort()
                      ? "cursor-pointer hover:text-[var(--gray-12)]"
                      : ""
                  }`}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                  {header.column.getCanSort() && (
                    <SortIcon dir={header.column.getIsSorted()} />
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
                  No cost events found for the selected time range.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
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

      {!loading && !error && data.length > 0 && (
        <p className="text-xs text-[var(--gray-09)]">
          {data.length} {data.length === 1 ? "row" : "rows"} — grouped by{" "}
          {GROUP_LABEL[groupBy].toLowerCase()}
        </p>
      )}
    </div>
  );
}
