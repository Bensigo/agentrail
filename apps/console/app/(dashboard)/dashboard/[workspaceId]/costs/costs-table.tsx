"use client";

import { useEffect, useState, useCallback } from "react";

interface CostRow {
  entity: string;
  total_tokens: number;
  total_cost_usd: number;
  model_call_tokens: number;
  model_call_cost: number;
  embedding_tokens: number;
  embedding_cost: number;
  reranking_tokens: number;
  reranking_cost: number;
  storage_tokens: number;
  storage_cost: number;
}

const groupByOptions = [
  { value: "run", label: "Run" },
  { value: "repo", label: "Repo" },
  { value: "team", label: "Team" },
  { value: "api_key", label: "API Key" },
] as const;

const timeRanges = [
  { label: "1h", ms: 3600_000 },
  { label: "6h", ms: 21600_000 },
  { label: "24h", ms: 86400_000 },
  { label: "7d", ms: 604800_000 },
  { label: "30d", ms: 2592000_000 },
] as const;

type SortKey = keyof CostRow;

export function CostsTable({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState("run");
  const [timeRange, setTimeRange] = useState("30d");
  const [sortKey, setSortKey] = useState<SortKey>("total_cost_usd");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const fetchData = useCallback(() => {
    setLoading(true);
    const range = timeRanges.find((r) => r.label === timeRange);
    const timeFrom = range
      ? new Date(Date.now() - range.ms).toISOString()
      : undefined;
    const params = new URLSearchParams({ group_by: groupBy });
    if (timeFrom) params.set("time_from", timeFrom);

    fetch(`/api/v1/workspaces/${workspaceId}/costs?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setRows(data.rows ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId, groupBy, timeRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") {
      return sortDir === "asc" ? av - bv : bv - av;
    }
    return sortDir === "asc"
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const fmt = (n: number) => `$${n.toFixed(4)}`;
  const fmtTokens = (n: number) => n.toLocaleString();

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-1">
          {groupByOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setGroupBy(opt.value)}
              className={`rounded-sm px-2 py-1 text-xs font-medium ${
                groupBy === opt.value
                  ? "bg-[var(--brand-accent)] text-[var(--gray-00)]"
                  : "text-[var(--gray-09)] hover:text-[var(--gray-11)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {timeRanges.map((r) => (
            <button
              key={r.label}
              onClick={() => setTimeRange(r.label)}
              className={`rounded-sm px-2 py-1 text-xs font-medium ${
                timeRange === r.label
                  ? "bg-[var(--gray-05)] text-[var(--gray-12)]"
                  : "text-[var(--gray-09)] hover:text-[var(--gray-11)]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="mt-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--gray-09)]">No cost data found.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
                {[
                  { key: "entity" as SortKey, label: "Entity" },
                  { key: "total_tokens" as SortKey, label: "Tokens" },
                  { key: "total_cost_usd" as SortKey, label: "Cost" },
                  { key: "model_call_cost" as SortKey, label: "Model" },
                  { key: "embedding_cost" as SortKey, label: "Embed" },
                  { key: "reranking_cost" as SortKey, label: "Rerank" },
                  { key: "storage_cost" as SortKey, label: "Storage" },
                ].map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className="cursor-pointer px-3 py-2 hover:text-[var(--gray-11)]"
                  >
                    {col.label}
                    {sortKey === col.key && (sortDir === "asc" ? " ↑" : " ↓")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr key={i} className="border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]">
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-12)]">
                    {row.entity ? row.entity.slice(0, 12) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-12)]">
                    {fmtTokens(row.total_tokens)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-medium text-[var(--gray-12)]">
                    {fmt(row.total_cost_usd)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-11)]">
                    {fmt(row.model_call_cost)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-11)]">
                    {fmt(row.embedding_cost)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-11)]">
                    {fmt(row.reranking_cost)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-11)]">
                    {fmt(row.storage_cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
