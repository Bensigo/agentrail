"use client";

import { useState, useEffect } from "react";
import { SectionSkeleton, SectionEmpty } from "./section-states";

interface RunCostRow {
  phase: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  tokens: number;
  cost_usd: number;
  occurred_at: string;
}

interface CostTotals {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  tokens: number;
}

interface CostsResponse {
  rows: RunCostRow[];
  totals: CostTotals;
}

interface CostSectionProps {
  workspaceId: string;
  runId: string;
  runStatus?: string;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function CostSection({ workspaceId, runId, runStatus }: CostSectionProps) {
  const [rows, setRows] = useState<RunCostRow[]>([]);
  const [totals, setTotals] = useState<CostTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/costs`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as CostsResponse;
        setRows(json.rows);
        setTotals(json.totals);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load cost data");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return <SectionSkeleton lines={3} />;
  }

  if (error) {
    return <p className="text-sm text-[#ff9592] py-4">{error}</p>;
  }

  if (rows.length === 0) {
    return (
      <SectionEmpty
        runStatus={runStatus}
        waitingText="Run in progress — cost events arrive as each phase completes."
        emptyText="No cost events recorded for this run."
      />
    );
  }

  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">Total cost</p>
          <p className="text-sm font-mono font-semibold text-[var(--gray-12)]">
            {totals ? fmtUsd(totals.total_cost_usd) : "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">Input tokens</p>
          <p className="text-sm font-mono font-semibold text-[var(--gray-12)]">
            {totals ? fmt(totals.input_tokens) : "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">Output tokens</p>
          <p className="text-sm font-mono font-semibold text-[var(--gray-12)]">
            {totals ? fmt(totals.output_tokens) : "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">
            Tokens served from cache
          </p>
          <p className="text-sm font-mono font-semibold text-[var(--gray-12)]">
            {totals ? fmt(totals.cache_tokens) : "—"}
          </p>
        </div>
      </div>

      {models.length > 0 && (
        <p className="text-xs text-[var(--gray-09)]">
          {models.length === 1 ? "Model" : "Models"}:{" "}
          <span className="font-mono text-[var(--gray-11)]">
            {models.join(", ")}
          </span>
        </p>
      )}

      {/* Per-phase table */}
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--gray-05)]">
              <th className="px-3 py-2 text-left font-medium text-[var(--gray-09)] uppercase tracking-wide">
                Phase
              </th>
              <th className="px-3 py-2 text-right font-medium text-[var(--gray-09)] uppercase tracking-wide">
                Input
              </th>
              <th className="px-3 py-2 text-right font-medium text-[var(--gray-09)] uppercase tracking-wide">
                Output
              </th>
              <th className="px-3 py-2 text-right font-medium text-[var(--gray-09)] uppercase tracking-wide">
                Cache
              </th>
              <th className="px-3 py-2 text-right font-medium text-[var(--gray-09)] uppercase tracking-wide">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-[var(--gray-04)] last:border-0"
              >
                <td className="px-3 py-2 font-mono text-[var(--gray-11)]">
                  {row.phase || <span className="text-[var(--gray-07)]">—</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {fmt(row.input_tokens)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {fmt(row.output_tokens)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {fmt(row.cache_tokens)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[var(--gray-11)]">
                  {fmtUsd(row.cost_usd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
