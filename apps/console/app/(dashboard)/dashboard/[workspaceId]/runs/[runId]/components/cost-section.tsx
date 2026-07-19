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

interface ContextPackTokens {
  tokens_saved: number;
}

interface ContextPacksResponse {
  context_packs: ContextPackTokens[];
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
  const [packTokensSaved, setPackTokensSaved] = useState(0);
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
    async function loadPackSavings() {
      // Tokens saved by context retrieval comes from this run's context packs.
      // A failure here must not blank the cost section; the stat falls back to
      // cache-read savings only.
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/context-packs`
        );
        if (!res.ok) return;
        const json = (await res.json()) as ContextPacksResponse;
        setPackTokensSaved(
          json.context_packs.reduce((sum, p) => sum + (p.tokens_saved || 0), 0)
        );
      } catch {
        // keep 0
      }
    }
    load();
    loadPackSavings();
  }, [workspaceId, runId]);

  if (loading) {
    return <SectionSkeleton lines={3} />;
  }

  if (error) {
    return <p className="text-sm text-[var(--red-11)] py-4">{error}</p>;
  }

  const tokensSaved = packTokensSaved + (totals?.cache_tokens ?? 0);
  const tokensSavedCard = (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
      <p className="text-xs text-[var(--gray-09)] mb-0.5">Tokens saved</p>
      <p className="text-sm font-mono font-bold text-[var(--gray-12)]">
        {fmt(tokensSaved)}
      </p>
      <p className="text-xs text-[var(--gray-09)]">
        context retrieval + cache reads
      </p>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{tokensSavedCard}</div>
        <SectionEmpty
          runStatus={runStatus}
          waitingText="Run in progress — cost events arrive as each phase completes."
          emptyText="No cost events recorded for this run."
        />
      </div>
    );
  }

  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">Total cost</p>
          <p className="text-sm font-mono font-bold text-[var(--gray-12)]">
            {totals ? fmtUsd(totals.total_cost_usd) : "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">Input tokens</p>
          <p className="text-sm font-mono font-bold text-[var(--gray-12)]">
            {totals ? fmt(totals.input_tokens) : "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">Output tokens</p>
          <p className="text-sm font-mono font-bold text-[var(--gray-12)]">
            {totals ? fmt(totals.output_tokens) : "—"}
          </p>
        </div>
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2">
          <p className="text-xs text-[var(--gray-09)] mb-0.5">
            Tokens served from cache
          </p>
          <p className="text-sm font-mono font-bold text-[var(--gray-12)]">
            {totals ? fmt(totals.cache_tokens) : "—"}
          </p>
        </div>
        {tokensSavedCard}
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
