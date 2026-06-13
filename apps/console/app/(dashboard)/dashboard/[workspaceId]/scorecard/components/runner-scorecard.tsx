"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { RunnerScoreRow } from "../../../../../lib/runner-scorecard";

interface Repository {
  id: string;
  name: string;
}

interface RunnerScorecardProps {
  workspaceId: string;
  repositories: Repository[];
}

type Range = "7d" | "30d" | "90d" | "all";
const RANGES: Range[] = ["7d", "30d", "90d", "all"];

function fmtPct(rate: number | null): string | null {
  if (rate === null) return null;
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtCost(usd: number | null): string | null {
  if (usd === null) return null;
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtEff(eff: number | null): string | null {
  if (eff === null) return null;
  return `${(eff * 100).toFixed(1)}%`;
}

function MetricCell({
  value,
  href,
}: {
  value: string | null;
  href: string;
}) {
  if (value === null) {
    return (
      <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-08)]">—</td>
    );
  }
  return (
    <td className="px-3 py-1.5 font-mono text-xs">
      <Link href={href} className="text-[#70b8ff] hover:underline">
        {value}
      </Link>
    </td>
  );
}

export function RunnerScorecard({ workspaceId, repositories }: RunnerScorecardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const range = (searchParams.get("range") as Range) ?? "30d";
  const repositoryId = searchParams.get("repositoryId") ?? "";
  const taskType = searchParams.get("taskType") ?? "";

  const [runners, setRunners] = useState<RunnerScoreRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const fetch_ = useCallback(
    async (r: Range, repoId: string, task: string) => {
      if (abortRef.current) abortRef.current.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setLoading(true);
      setError(null);

      const qs = new URLSearchParams({ range: r });
      if (repoId) qs.set("repositoryId", repoId);
      if (task) qs.set("taskType", task);

      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/scorecard/runners?${qs.toString()}`,
          { signal: ac.signal }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { runners: RunnerScoreRow[] };
        setRunners(json.runners);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError("Failed to load runner scorecard.");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    fetch_(range, repositoryId, taskType);
  }, [range, repositoryId, taskType, fetch_]);

  function updateParams(updates: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  const runsBase = `/dashboard/${workspaceId}/runs`;

  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        By runner
      </h2>

      {/* Filter bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Repository selector */}
        <select
          value={repositoryId}
          onChange={(e) => updateParams({ repositoryId: e.target.value })}
          className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-sm text-[var(--gray-11)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
          aria-label="Repository filter"
        >
          <option value="">All repositories</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        {/* Time range quick buttons */}
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => updateParams({ range: r })}
              className={`h-8 rounded px-3 text-sm transition-colors ${
                range === r
                  ? "bg-[var(--gray-05)] text-[var(--gray-12)]"
                  : "bg-[var(--gray-02)] border border-[var(--gray-05)] text-[var(--gray-09)] hover:bg-[var(--gray-03)]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Task type text input */}
        <input
          type="text"
          value={taskType}
          onChange={(e) => updateParams({ taskType: e.target.value })}
          placeholder="Task type"
          className="h-8 w-32 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-sm text-[var(--gray-11)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
          aria-label="Task type filter"
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-6 py-8 text-center">
          <p className="animate-pulse text-sm text-[var(--gray-09)]">Loading runner data…</p>
        </div>
      ) : error ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-6 py-8 text-center">
          <p className="text-sm text-[#ff9592]">{error}</p>
        </div>
      ) : runners !== null && runners.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-6 py-8 text-center">
          <p className="text-sm text-[var(--gray-09)]">
            No runner data for the selected filters.
          </p>
        </div>
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                {[
                  "Runner",
                  "Runs",
                  "Success rate",
                  "Review fix rate",
                  "Human review rate",
                  "Cost/merged PR",
                  "Context efficiency",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(runners ?? []).map((row) => {
                const drillHref = `${runsBase}?runner_name=${encodeURIComponent(row.runner_name)}`;
                return (
                  <tr
                    key={row.runner_name}
                    className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                    style={{ height: "34px" }}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-12)] font-medium">
                      {row.runner_name || "—"}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                      <Link href={drillHref} className="text-[#70b8ff] hover:underline">
                        {row.run_ids.length.toLocaleString()}
                      </Link>
                    </td>
                    <MetricCell value={fmtPct(row.success_rate)} href={drillHref} />
                    <MetricCell value={fmtPct(row.review_fix_rate)} href={drillHref} />
                    <MetricCell value={fmtPct(row.human_review_rate)} href={drillHref} />
                    <MetricCell value={fmtCost(row.cost_per_merged_pr)} href={drillHref} />
                    <MetricCell value={fmtEff(row.context_efficiency)} href={drillHref} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
