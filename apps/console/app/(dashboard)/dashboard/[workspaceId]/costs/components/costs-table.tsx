"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "../../../../components/data-table";
import { StatHeader } from "../../../../components/stat-header";
import {
  TIME_RANGES,
  timeRangeToFrom,
  type TimeRange,
} from "./cost-filters";

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

interface CostsTableProps {
  workspaceId: string;
  timeRange: TimeRange;
  onTimeRangeToggle: (range: TimeRange) => void;
}

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

const columnHelper = createColumnHelper<CostRow>();

function buildColumns(groupBy: GroupBy): ColumnDef<CostRow, unknown>[] {
  return [
    columnHelper.accessor("entity_id", {
      id: "entity_id",
      header: GROUP_LABEL[groupBy],
      meta: { mono: true },
      cell: (info) => (
        <span className="truncate max-w-[200px] block text-[var(--gray-12)]">
          {info.getValue() || "—"}
        </span>
      ),
    }),
    columnHelper.accessor("total_tokens", {
      id: "total_tokens",
      header: "Total tokens",
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-11)]">
          {fmtTokens(info.getValue() as number)}
        </span>
      ),
    }),
    columnHelper.accessor("total_cost_usd", {
      id: "total_cost_usd",
      header: "Total cost",
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-12)] font-medium">
          {fmtCost(info.getValue() as number)}
        </span>
      ),
    }),
    columnHelper.accessor("model_call_cost_usd", {
      id: "model_call_cost_usd",
      header: "Model calls",
      meta: { mono: true },
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="text-[var(--gray-11)]">
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
      meta: { mono: true },
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="text-[var(--gray-11)]">
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
      meta: { mono: true },
      cell: (info) => {
        const row = info.row.original;
        return (
          <span className="text-[var(--gray-11)]">
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
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-11)]">
          {fmtCost(info.getValue() as number)}
        </span>
      ),
    }),
    columnHelper.accessor("event_count", {
      id: "event_count",
      header: "Events",
      meta: { mono: true },
      cell: (info) => (
        <span className="text-[var(--gray-10)]">
          {(info.getValue() as number).toLocaleString()}
        </span>
      ),
    }),
  ] as ColumnDef<CostRow, unknown>[];
}

export function CostsTable({
  workspaceId,
  timeRange,
  onTimeRangeToggle,
}: CostsTableProps) {
  const [data, setData] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("repo");

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
  }, [fetchCosts, groupBy, timeRange]);

  const totalCost = data.reduce((sum, r) => sum + r.total_cost_usd, 0);
  const totalTokens = data.reduce((sum, r) => sum + r.total_tokens, 0);

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {GROUP_BY_OPTIONS.map(({ label, value }) => (
          <button
            key={value}
            onClick={() => setGroupBy(value)}
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

      <div className="flex items-center gap-1">
        {TIME_RANGES.map(({ label, value }) => (
          <button
            key={value || "all"}
            onClick={() => onTimeRangeToggle(value)}
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
  );

  return (
    <div className="flex flex-col gap-4">
      {!loading && !error && (
        <StatHeader
          stats={[
            { label: "Total cost", value: fmtCost(totalCost) },
            { label: "Total tokens", value: fmtTokens(totalTokens) },
            {
              label: "Rows",
              value: data.length,
              detail: `grouped by ${GROUP_LABEL[groupBy].toLowerCase()}`,
            },
          ]}
        />
      )}
      <DataTable
        columns={columns}
        data={data}
        loading={loading}
        error={error}
        emptyMessage="No cost events found for the selected time range."
        filterBar={filterBar}
        onRetry={() => fetchCosts(groupBy, timeRange)}
      />
    </div>
  );
}
