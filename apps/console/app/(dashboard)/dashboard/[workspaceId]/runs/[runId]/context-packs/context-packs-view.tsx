"use client";

import { useEffect, useState } from "react";

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
  included: IncludedItem[];
  excluded: ExcludedItem[];
}

export function ContextPacksView({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [packs, setPacks] = useState<ContextPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"included" | "excluded">("included");

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/runs/${runId}/context-packs`)
      .then((r) => r.json())
      .then((data) => {
        setPacks(data.packs ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  if (packs.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--gray-09)]">
        No context packs recorded for this run.
      </p>
    );
  }

  return (
    <div className="mt-6 space-y-8">
      {packs.map((pack) => (
        <div key={pack.context_pack_id} className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)]">
          <div className="border-b border-[var(--gray-04)] p-4">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-medium text-[var(--purple-11,var(--gray-12))]">
                {pack.context_pack_id.slice(0, 8)}
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs uppercase text-[var(--gray-09)]">Token Budget</p>
                <p className="font-mono text-sm text-[var(--gray-12)]">
                  {pack.token_budget.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-[var(--gray-09)]">Tokens Used</p>
                <p className="font-mono text-sm text-[var(--gray-12)]">
                  {pack.tokens_used.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-[var(--gray-09)]">Anchors</p>
                <p className="font-mono text-sm text-[var(--gray-12)]">
                  {pack.anchors_extracted}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-[var(--gray-09)]">Sources</p>
                <p className="font-mono text-sm text-[var(--gray-12)]">
                  {pack.sources_considered}
                </p>
              </div>
            </div>
          </div>

          <div className="flex border-b border-[var(--gray-04)]">
            <button
              onClick={() => setActiveTab("included")}
              className={`px-4 py-2 text-sm font-medium ${
                activeTab === "included"
                  ? "border-b-2 border-[var(--brand-accent)] text-[var(--gray-12)]"
                  : "text-[var(--gray-09)] hover:text-[var(--gray-11)]"
              }`}
            >
              Included ({pack.included.length})
            </button>
            <button
              onClick={() => setActiveTab("excluded")}
              className={`px-4 py-2 text-sm font-medium ${
                activeTab === "excluded"
                  ? "border-b-2 border-[var(--brand-accent)] text-[var(--gray-12)]"
                  : "text-[var(--gray-09)] hover:text-[var(--gray-11)]"
              }`}
            >
              Excluded ({pack.excluded.length})
            </button>
          </div>

          <div className="overflow-x-auto">
            {activeTab === "included" ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
                    <th className="px-4 py-2">File Path</th>
                    <th className="px-4 py-2">Citation</th>
                    <th className="px-4 py-2">Reason</th>
                    <th className="px-4 py-2 text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {pack.included.map((item, i) => (
                    <tr key={i} className="border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]">
                      <td className="px-4 py-2 font-mono text-xs text-[var(--gray-12)]">
                        {item.path}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--gray-11)]">
                        {item.citation}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--gray-11)]">
                        {item.reason}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-[var(--gray-12)]">
                        {item.score.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
                    <th className="px-4 py-2">File Path</th>
                    <th className="px-4 py-2">Exclusion Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {pack.excluded.map((item, i) => (
                    <tr key={i} className="border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]">
                      <td className="px-4 py-2 font-mono text-xs text-[var(--gray-12)]">
                        {item.path}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--gray-11)]">
                        {item.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
