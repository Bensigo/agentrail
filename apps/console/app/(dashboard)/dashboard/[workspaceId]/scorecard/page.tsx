import { Suspense } from "react";
import { getAgentRunStats, listWorkspaceRepositories } from "@agentrail/db-postgres";
import { getAgentModelCosts } from "@agentrail/db-clickhouse";
import { buildScorecard } from "../../../../../lib/scorecard";
import type { AgentScorecardRow, ModelScorecardRow } from "../../../../../lib/scorecard";
import { RunnerScorecardSection } from "./components/runner-scorecard-section";

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtDuration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function AgentTable({ rows }: { rows: AgentScorecardRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--gray-09)]">
        No finished runs yet.
      </p>
    );
  }
  return (
    <div className="rounded border border-[var(--gray-05)] overflow-hidden">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
            {["Agent", "Runs", "Finished", "Success rate", "Avg duration", "Avg review rounds"].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agent} className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors" style={{ height: "34px" }}>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-12)] font-medium">
                {row.agent || "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {row.runs.toLocaleString()}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {row.finishedRuns.toLocaleString()}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs">
                <span className={row.successRate >= 0.8 ? "text-[#30a46c]" : row.successRate >= 0.5 ? "text-[#e5a100]" : "text-[var(--red-09)]"}>
                  {row.finishedRuns > 0 ? fmtPct(row.successRate) : "—"}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {fmtDuration(row.avgDurationS)}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {row.avgReviewRounds.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelTable({ rows }: { rows: ModelScorecardRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--gray-09)]">
        No model cost data yet.
      </p>
    );
  }
  return (
    <div className="rounded border border-[var(--gray-05)] overflow-hidden">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
            {["Model", "Runs", "Total cost", "Avg cost/run", "Input tokens", "Output tokens", "Cache tokens", "Cache ratio"].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.model} className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors" style={{ height: "34px" }}>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-12)] font-medium">
                {row.model || "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {row.runs.toLocaleString()}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-12)] font-medium">
                {fmtCost(row.totalCostUsd)}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {fmtCost(row.avgCostUsd)}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {fmtTokens(row.inputTokens)}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {fmtTokens(row.outputTokens)}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {fmtTokens(row.cacheTokens)}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-[var(--gray-11)]">
                {row.cacheTokens > 0 ? fmtPct(row.cacheRatio) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ScorecardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  // No .catch(() => []): a DB outage must surface via the Next.js error
  // boundary, not render as a legitimate-looking empty scorecard.
  const [pgRows, chRows] = await Promise.all([
    getAgentRunStats(workspaceId),
    getAgentModelCosts(workspaceId),
  ]);

  let repositories: { id: string; name: string }[] = [];
  try {
    const repos = await listWorkspaceRepositories(workspaceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repositories = repos.map((r: any) => ({ id: r.id, name: r.name }));
  } catch {
    // DB unavailable; empty repo list renders filter without options
  }

  const { agents, models } = buildScorecard(pgRows, chRows);

  const hasFinishedRuns = agents.some((a) => a.finishedRuns > 0);

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="text-sm font-semibold text-[var(--gray-12)]">
        Agent Scorecard
      </h1>
      <p className="mb-4 mt-1 text-xs text-[var(--gray-09)]">
        How reliably each agent and model Jace uses ships working code, by
        the numbers.
      </p>

      {!hasFinishedRuns && agents.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-6 py-10 text-center">
          <p className="text-sm text-[var(--gray-09)]">
            No finished runs yet. Scorecard will populate once runs complete.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              By agent
            </h2>
            <AgentTable rows={agents} />
          </section>

          <section>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              By model
            </h2>
            <ModelTable rows={models} />
          </section>

          <Suspense
            fallback={
              <section>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  By runner
                </h2>
                <div className="rounded border border-[var(--gray-05)] px-3 py-8 text-center text-sm text-[var(--gray-09)] animate-pulse">
                  Loading runner data…
                </div>
              </section>
            }
          >
            <RunnerScorecardSection
              workspaceId={workspaceId}
              repositories={repositories}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
