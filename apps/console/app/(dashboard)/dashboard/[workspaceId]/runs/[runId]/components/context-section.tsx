"use client";

import { useState, useEffect } from "react";

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

function TokenBar({
  used,
  budget,
}: {
  used: number;
  budget: number;
}) {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  const barColor =
    pct >= 90 ? "#ff9592" : pct >= 70 ? "#f5e147" : "#1fd8a4";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs font-mono text-[var(--gray-09)]">
        <span>
          {used.toLocaleString()} / {budget.toLocaleString()} tokens
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--gray-04)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
    </div>
  );
}

function SourceRow({ item }: { item: IncludedItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-[var(--gray-04)] last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-center gap-3 px-4 py-2 hover:bg-[var(--gray-02)] transition-colors"
      >
        <span className="flex-1 text-xs font-mono text-[var(--gray-11)] truncate">
          {item.path}
        </span>
        <span className="text-xs font-mono text-[var(--gray-08)] shrink-0">
          {item.score.toFixed(2)}
        </span>
        <span className="text-xs text-[var(--gray-08)] shrink-0">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && item.reason && (
        <div className="px-4 pb-3 pt-0.5">
          <p className="text-xs text-[var(--gray-09)]">{item.reason}</p>
        </div>
      )}
    </div>
  );
}

interface ContextSectionProps {
  workspaceId: string;
  runId: string;
}

export function ContextSection({ workspaceId, runId }: ContextSectionProps) {
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/context-packs`
        );
        if (res.ok) {
          const json = (await res.json()) as ContextPacksResponse;
          setPacks(json.context_packs ?? []);
        }
      } catch {
        // non-fatal
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

  if (packs.length === 0) {
    return (
      <p className="text-sm text-[var(--gray-09)] py-4">
        No context packs recorded for this run.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {packs.map((pack) => (
        <div key={pack.context_pack_id}>
          <div className="flex items-center gap-4 mb-3 text-xs font-mono text-[var(--gray-09)]">
            <span title="Context pack ID" className="truncate">
              {pack.context_pack_id.slice(0, 12)}…
            </span>
            <span>{pack.sources_considered} sources considered</span>
            {pack.anchors_extracted > 0 && (
              <span>{pack.anchors_extracted} anchors</span>
            )}
          </div>

          <TokenBar used={pack.tokens_used} budget={pack.token_budget} />

          {pack.included.length > 0 && (
            <div className="mt-3 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] overflow-hidden">
              <div className="px-4 py-2 border-b border-[var(--gray-04)]">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Included sources ({pack.included.length})
                </p>
              </div>
              {pack.included.map((item) => (
                <SourceRow key={item.path} item={item} />
              ))}
            </div>
          )}

          {pack.included.length === 0 && (
            <p className="mt-3 text-xs text-[var(--gray-09)]">
              No source items recorded.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
