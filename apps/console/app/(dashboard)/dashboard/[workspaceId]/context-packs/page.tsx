import Link from "next/link";
import { BookOpen } from "lucide-react";
import { getWorkspaceContextPacks } from "@agentrail/db-clickhouse";
import type { ContextPackRecord } from "@agentrail/db-clickhouse";
import { listRuns, listWorkspaceRepositories } from "@agentrail/db-postgres";
import { EmptyState } from "../../../../components/empty-state";
import { StatusBadge } from "../runs/components/status-badge";

interface RunInfo {
  title: string | null;
  status: string;
  repositoryId: string;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** "2h ago"-style relative time; falls back to a short date beyond 30 days. */
function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function retrievedSummary(p: ContextPackRecord): string {
  const parts: string[] = [];
  if (p.sources_considered > 0) {
    parts.push(
      `${p.sources_considered} source${p.sources_considered === 1 ? "" : "s"}`
    );
  }
  if (p.anchors_extracted > 0) {
    parts.push(
      `${p.anchors_extracted} anchor${p.anchors_extracted === 1 ? "" : "s"}`
    );
  }
  return parts.length > 0 ? parts.join(", ") : "—";
}

export default async function ContextPacksPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  let packs: ContextPackRecord[] = [];
  let loadError = false;
  try {
    packs = await getWorkspaceContextPacks(workspaceId);
  } catch {
    loadError = true;
  }

  // Run status/title and repository names come from Postgres. If that lookup
  // fails the table still renders with run-id prefixes.
  const runsById = new Map<string, RunInfo>();
  const repoNameById = new Map<string, string>();
  try {
    const [runs, repos] = await Promise.all([
      listRuns(workspaceId),
      listWorkspaceRepositories(workspaceId),
    ]);
    for (const repo of repos) repoNameById.set(repo.id, repo.name);
    for (const run of runs) {
      runsById.set(run.id, {
        title: run.title,
        status: run.status,
        repositoryId: run.repositoryId,
      });
    }
  } catch {
    // degrade gracefully
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-1 text-sm font-semibold text-[var(--gray-12)]">
        Context Packs
      </h1>
      <p className="mb-4 text-xs text-[var(--gray-09)]">
        A context pack is the bundle of code snippets AgentRail retrieved for an
        agent before it started working — what it read, and how many tokens that
        took versus reading whole files.
      </p>
      {loadError ? (
        <p className="py-8 text-center text-sm text-[#ff9592]">
          Failed to load context packs. ClickHouse may be unavailable — try
          again shortly.
        </p>
      ) : packs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No context packs yet"
          description="Context packs gathered for agent runs will appear here."
        />
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Run
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Repository
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Retrieved
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Tokens
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Gathered
                </th>
              </tr>
            </thead>
            <tbody>
              {packs.map((p) => {
                const run = runsById.get(p.run_id);
                const repoName = run
                  ? repoNameById.get(run.repositoryId) ?? run.repositoryId
                  : null;
                return (
                  <tr
                    key={p.context_pack_id}
                    className="border-b border-[var(--gray-04)] last:border-0"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/dashboard/${workspaceId}/runs/${p.run_id}`}
                          className="text-[#70b8ff] hover:underline"
                        >
                          {run?.title || (
                            <span className="font-mono">
                              {p.run_id.slice(0, 8)}
                            </span>
                          )}
                        </Link>
                        {run && <StatusBadge status={run.status} />}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[var(--gray-11)]">
                      {repoName ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--gray-11)]">
                      {retrievedSummary(p)}
                    </td>
                    <td className="px-3 py-2">
                      {p.tokens_used > 0 || p.token_budget > 0 ? (
                        <div>
                          <span className="font-mono text-[var(--gray-12)]">
                            {fmt(p.tokens_used)}
                          </span>{" "}
                          <span className="text-[var(--gray-09)]">
                            used
                            {p.token_budget > 0 && (
                              <> of {fmt(p.token_budget)} budget</>
                            )}
                          </span>
                          {p.tokens_saved > 0 && (
                            <p className="text-xs text-[var(--gray-09)]">
                              <span className="font-mono text-[#1fd8a4]">
                                {fmt(p.tokens_saved)}
                              </span>{" "}
                              saved
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-[var(--gray-07)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--gray-10)]">
                      {timeAgo(new Date(p.occurred_at))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
