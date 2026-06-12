"use client";

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

interface IncludedItem {
  path: string;
  citation: string;
  reason: string;
  score: number;
}

interface ExcludedItem {
  path: string;
  reason: string;
}

interface ContextPack {
  context_pack_id: string;
  token_budget: number;
  tokens_used: number;
  anchors_extracted: number;
  sources_considered: number;
  occurred_at: string;
  included: IncludedItem[];
  excluded: ExcludedItem[];
}

interface ContextPacksResponse {
  context_packs: ContextPack[];
}

interface ContextSectionProps {
  workspaceId: string;
  runId: string;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function BudgetBar({ used, budget }: { used: number; budget: number }) {
  const pct = budget > 0 ? Math.min((used / budget) * 100, 100) : 0;
  const over = budget > 0 && used > budget;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-[var(--gray-09)]">Tokens used vs budget</span>
        <span className="font-mono text-[var(--gray-11)]">
          {fmt(used)} / {budget > 0 ? fmt(budget) : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-[var(--gray-04)] overflow-hidden">
        <div
          className={`h-full rounded-full ${over ? "bg-[#ff9592]" : "bg-[#70b8ff]"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PackCard({ pack }: { pack: ContextPack }) {
  const [expanded, setExpanded] = useState(false);
  const sourceCount = pack.included.length + pack.excluded.length;

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-3 space-y-3">
      <BudgetBar used={pack.tokens_used} budget={pack.token_budget} />

      <button
        onClick={() => setExpanded((e) => !e)}
        disabled={sourceCount === 0}
        className="flex items-center gap-1 text-xs text-[var(--gray-11)] transition-colors hover:text-[var(--gray-12)] disabled:cursor-default disabled:text-[var(--gray-08)]"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {sourceCount === 0
          ? "No source details recorded"
          : `${sourceCount} source${sourceCount === 1 ? "" : "s"}`}
      </button>

      {expanded && sourceCount > 0 && (
        <ul className="space-y-1.5">
          {pack.included.map((item, i) => (
            <li
              key={`inc-${i}`}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <div className="min-w-0">
                <span className="font-mono text-[var(--gray-12)] break-all">
                  {item.path}
                </span>
                {item.reason && (
                  <span className="ml-2 text-[var(--gray-09)]">
                    {item.reason}
                  </span>
                )}
              </div>
              <span className="shrink-0 font-mono text-[var(--gray-11)]">
                {item.score.toFixed(2)}
              </span>
            </li>
          ))}
          {pack.excluded.map((item, i) => (
            <li
              key={`exc-${i}`}
              className="flex items-baseline justify-between gap-3 text-xs text-[var(--gray-08)]"
            >
              <div className="min-w-0">
                <span className="font-mono line-through break-all">
                  {item.path}
                </span>
                {item.reason && <span className="ml-2">{item.reason}</span>}
              </div>
              <span className="shrink-0">excluded</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ContextSection({ workspaceId, runId }: ContextSectionProps) {
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/context-packs`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as ContextPacksResponse;
        setPacks(json.context_packs);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load context data");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <p className="text-sm text-[var(--gray-09)] animate-pulse py-4">
        Loading context…
      </p>
    );
  }

  if (error) {
    return <p className="text-sm text-[#ff9592] py-4">{error}</p>;
  }

  if (packs.length === 0) {
    return (
      <p className="text-sm text-[var(--gray-09)] py-4">
        No context packs recorded for this run.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {packs.map((pack) => (
        <PackCard key={pack.context_pack_id} pack={pack} />
      ))}
    </div>
  );
}
