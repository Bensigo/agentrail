"use client";

import { useEffect, useCallback, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

export interface RunnerScoreRow {
  runner_name: string;
  /** IDs of runs associated with this runner in the filtered window. */
  run_ids: string[];
  success_rate: number | null;
  review_fix_rate: number | null;
  human_review_rate: number | null;
  cost_per_merged_pr: number | null;
  context_efficiency: number | null;
}

interface RepoOption {
  id: string;
  name: string;
}

export interface RunnerScorecardSectionProps {
  workspaceId: string;
  repositories: RepoOption[];
}

type ScoreTimeRange = "7d" | "30d" | "90d" | "";

const TIME_RANGES: { label: string; value: ScoreTimeRange }[] = [
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "all", value: "" },
];

function timeRangeToFrom(range: ScoreTimeRange): Date | undefined {
  if (!range) return undefined;
  const ms: Record<string, number> = {
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - ms[range]);
}

function fmtPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtEfficiency(val: number | null): string {
  if (val === null) return "—";
  return `${(val * 100).toFixed(1)}%`;
}

function MetricCell({ value, href }: { value: string; href?: string }) {
  if (value === "—" || !href) {
    return (
      <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-09)]">
        {value}
      </td>
    );
  }
  return (
    <td className="px-3 py-1.5 font-mono text-xs">
      <a href={href} className="text-[#70b8ff] hover:underline">
        {value}
      </a>
    </td>
  );
}

const COL_COUNT = 7;

export function RunnerScorecardSection({
  workspaceId,
  repositories,
}: RunnerScorecardSectionProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const timeRange = (searchParams.get("time_range") ?? "") as ScoreTimeRange;
  const repositoryId = searchParams.get("repository_id") ?? "";
  const taskType = searchParams.get("task_type") ?? "";

  const [runners, setRunners] = useState<RunnerScoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, pathname, router]
  );

  const fetchRunners = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(
        `/api/v1/workspaces/${workspaceId}/scorecard/runners`,
        window.location.origin
      );
      if (repositoryId) url.searchParams.set("repository_id", repositoryId);
      if (timeRange) {
        const from = timeRangeToFrom(timeRange);
        if (from) url.searchParams.set("time_from", from.toISOString());
      }
      if (taskType) url.searchParams.set("task_type", taskType);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      const json = (await res.json()) as { runners: RunnerScoreRow[] };
      setRunners(json.runners ?? []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load runner scorecard"
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId, repositoryId, timeRange, taskType]);

  useEffect(() => {
    fetchRunners();
  }, [fetchRunners]);

  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
        By runner
      </h2>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={repositoryId}
          onChange={(e) => updateParam("repository_id", e.target.value)}
          className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
        >
          <option value="">All repos</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {TIME_RANGES.map(({ label, value }) => (
            <button
              key={label}
              onClick={() => updateParam("time_range", value)}
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

        <input
          type="text"
          value={taskType}
          onChange={(e) => updateParam("task_type", e.target.value)}
          placeholder="Task type"
          className="h-8 w-36 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-sm font-mono text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629]"
        />
      </div>

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
            {loading ? (
              <tr>
                <td
                  colSpan={COL_COUNT}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  <span className="animate-pulse">Loading runner data…</span>
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td
                  colSpan={COL_COUNT}
                  className="px-3 py-8 text-center text-sm text-[#ff9592]"
                >
                  {error}
                </td>
              </tr>
            ) : runners.length === 0 ? (
              <tr>
                <td
                  colSpan={COL_COUNT}
                  className="px-3 py-8 text-center text-sm text-[var(--gray-09)]"
                >
                  No runner data for the selected filters.
                </td>
              </tr>
            ) : (
              runners.map((row) => {
                const runsUrl = `/dashboard/${workspaceId}/runs?runner_name=${encodeURIComponent(row.runner_name)}`;
                return (
                  <tr
                    key={row.runner_name}
                    className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                    style={{ height: "34px" }}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-12)] font-medium">
                      {row.runner_name}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                      {row.run_ids.length.toLocaleString()}
                    </td>
                    <MetricCell
                      value={fmtPct(row.success_rate)}
                      href={row.success_rate !== null ? runsUrl : undefined}
                    />
                    <MetricCell
                      value={fmtPct(row.review_fix_rate)}
                      href={
                        row.review_fix_rate !== null ? runsUrl : undefined
                      }
                    />
                    <MetricCell
                      value={fmtPct(row.human_review_rate)}
                      href={
                        row.human_review_rate !== null ? runsUrl : undefined
                      }
                    />
                    <MetricCell
                      value={fmtCost(row.cost_per_merged_pr)}
                      href={
                        row.cost_per_merged_pr !== null ? runsUrl : undefined
                      }
                    />
                    <MetricCell
                      value={fmtEfficiency(row.context_efficiency)}
                      href={
                        row.context_efficiency !== null ? runsUrl : undefined
                      }
                    />
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
