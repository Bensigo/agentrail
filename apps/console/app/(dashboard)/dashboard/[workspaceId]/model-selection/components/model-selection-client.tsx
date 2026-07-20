"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "../../../../../components/loading-skeleton";

interface ModelBreakdownEntry {
  model: string;
  displayName: string;
  isSeed: boolean;
  qualified: boolean;
  runCount: number;
  successCount: number;
  successRate: number;
  avgCostUsd: number;
  costPerSuccess: number | null;
}

interface TaskTypeBreakdown {
  taskType: string;
  seedModel: string;
  models: ModelBreakdownEntry[];
}

interface ModelSelectionData {
  learningEnabled: boolean;
  taskTypes: TaskTypeBreakdown[];
}

const usd = (n: number) => `$${n.toFixed(3)}`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const TASK_LABELS: Record<string, string> = {
  ui: "UI",
  refactor: "Refactor",
  mechanical: "Mechanical",
  general: "General",
};

interface ModelSelectionClientProps {
  workspaceId: string;
}

export function ModelSelectionClient({ workspaceId }: ModelSelectionClientProps) {
  const [data, setData] = useState<ModelSelectionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/workspaces/${workspaceId}/model-selection`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as ModelSelectionData;
        if (active) setData(json);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Failed to load model selection data");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error) return <p className="py-3 text-sm text-[var(--red-11)]">{error}</p>;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-2 text-xs text-[var(--gray-09)]">
        Auto-selection is{" "}
        <span
          className={
            data.learningEnabled ? "text-[var(--green-11)]" : "text-[var(--gray-11)]"
          }
        >
          {data.learningEnabled ? "ON" : "OFF"}
        </span>{" "}
        for this workspace — while off, every brief uses the static seed below
        regardless of what the data shows.
      </div>

      {data.taskTypes.map((tt) => (
        <div
          key={tt.taskType}
          className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4"
        >
          <h2 className="mb-2 text-sm font-bold text-[var(--gray-12)]">
            {TASK_LABELS[tt.taskType] ?? tt.taskType}
          </h2>
          <div className="overflow-x-auto rounded border border-[var(--gray-05)]">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--gray-05)] text-left text-[var(--gray-09)]">
                  <th className="px-3 py-1.5 font-medium">Model</th>
                  <th className="px-3 py-1.5 font-medium">Runs</th>
                  <th className="px-3 py-1.5 font-medium">Success rate</th>
                  <th className="px-3 py-1.5 font-medium">Avg cost</th>
                  <th className="px-3 py-1.5 font-medium">$ / success</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--gray-04)]">
                {tt.models.map((m) => (
                  <tr key={m.model}>
                    <td className="px-3 py-1.5">
                      <span className="text-[var(--gray-12)]">{m.displayName}</span>
                      {m.isSeed && (
                        <span className="ml-1.5 rounded-sm bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] px-1.5 py-0.5 text-xs text-[var(--blue-11)]">
                          seed
                        </span>
                      )}
                      {!m.qualified && (
                        <span className="ml-1.5 rounded-sm bg-[color-mix(in_srgb,var(--gray-11)_12%,transparent)] px-1.5 py-0.5 text-xs text-[var(--gray-09)]">
                          not enough data
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">{m.runCount}</td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">
                      {m.runCount > 0 ? pct(m.successRate) : "—"}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">
                      {m.runCount > 0 ? usd(m.avgCostUsd) : "—"}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--gray-11)]">
                      {m.costPerSuccess !== null ? usd(m.costPerSuccess) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
