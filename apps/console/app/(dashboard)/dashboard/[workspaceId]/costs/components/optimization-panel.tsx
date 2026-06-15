"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "../../../../../components/loading-skeleton";

interface OptimizationData {
  cache: { hitRate: number; cachedDollarsSaved: number; cacheTokens: number };
  output: { outputInputRatio: number; outputCostUsd: number; outputTokens: number };
  routing: {
    premiumSpendUsd: number;
    models: {
      model: string;
      runCount: number;
      totalCostUsd: number;
      cacheHitRate: number;
      outputInputRatio: number;
      premium: boolean;
    }[];
  };
  estimate: boolean;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

interface OptimizationPanelProps {
  workspaceId: string;
}

export function OptimizationPanel({ workspaceId }: OptimizationPanelProps) {
  const [data, setData] = useState<OptimizationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/costs/optimization`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as OptimizationData;
        if (active) setData(json);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Failed to load optimization metrics");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (error) return <p className="py-3 text-sm text-[var(--red-11)]">{error}</p>;
  if (!data) return null;

  const est = data.estimate ? (
    <span title="Some models aren't in the price table; dollar figures are estimates." className="ml-1 text-[var(--gray-08)]">~est</span>
  ) : null;

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-[var(--gray-12)]">Cost optimization</h2>
        <p className="mt-0.5 text-xs text-[var(--gray-09)]">
          Where spend is going and where it can be cut — prompt caching, output
          tokens (priced ~5x input), and model right-sizing. {est}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Prompt cache hit rate"
          value={pct(data.cache.hitRate)}
          sub={`${usd(data.cache.cachedDollarsSaved)} saved vs uncached`}
        />
        <Stat
          label="Output : input ratio"
          value={data.output.outputInputRatio.toFixed(1) + "x"}
          sub={`${usd(data.output.outputCostUsd)} on output tokens`}
          tone={data.output.outputInputRatio > 2 ? "warn" : undefined}
        />
        <Stat
          label="Premium-model spend"
          value={usd(data.routing.premiumSpendUsd)}
          sub="on Opus/Fable — routing target"
          tone={data.routing.premiumSpendUsd > 0 ? "warn" : undefined}
        />
      </div>

      {data.routing.models.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            By model
          </p>
          <div className="overflow-x-auto rounded border border-[var(--gray-05)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--gray-05)] text-left text-[var(--gray-09)]">
                  <th className="px-3 py-1.5 font-medium">Model</th>
                  <th className="px-3 py-1.5 font-medium">Runs</th>
                  <th className="px-3 py-1.5 font-medium">Cost</th>
                  <th className="px-3 py-1.5 font-medium">Cache hit</th>
                  <th className="px-3 py-1.5 font-medium">Out:in</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--gray-04)]">
                {data.routing.models.map((m) => (
                  <tr key={m.model}>
                    <td className="px-3 py-1.5">
                      <span className="font-mono text-[var(--gray-12)]">{m.model}</span>
                      {m.premium && (
                        <span className="ml-1.5 rounded-sm bg-[color-mix(in_srgb,var(--orange-11)_16%,transparent)] px-1 py-0.5 text-[10px] text-[var(--orange-11)]">
                          premium
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">{m.runCount}</td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">{usd(m.totalCostUsd)}</td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">{pct(m.cacheHitRate)}</td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">{m.outputInputRatio.toFixed(1)}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-3 py-2.5">
      <p className="text-xs text-[var(--gray-09)]">{label}</p>
      <p
        className={`mt-0.5 font-mono text-xl font-bold ${
          tone === "warn" ? "text-[var(--orange-11)]" : "text-[var(--gray-12)]"
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-[var(--gray-09)]">{sub}</p>
    </div>
  );
}
