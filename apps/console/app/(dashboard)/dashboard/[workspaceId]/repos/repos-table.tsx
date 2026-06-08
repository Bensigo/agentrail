"use client";

import { useEffect, useState } from "react";

interface Repo {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  lastCommitSha: string | null;
  lastIndexedAt: string | null;
  stalenessSeconds: number;
  codebaseUnits: number;
  graphEdges: number;
  healthStatus: "healthy" | "stale" | "critical";
}

const healthColors: Record<string, string> = {
  healthy: "bg-[#29a383]",
  stale: "bg-[#f5d90a]",
  critical: "bg-[#e5484d]",
};

function formatAge(seconds: number): string {
  if (seconds < 0) return "Never";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function ReposTable({ workspaceId }: { workspaceId: string }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/repos`)
      .then((r) => r.json())
      .then((data) => {
        setRepos(data.repos ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--gray-09)]">No repositories found.</p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
            <th className="px-3 py-2">Health</th>
            <th className="px-3 py-2">Repository</th>
            <th className="px-3 py-2">Last Commit</th>
            <th className="px-3 py-2">Index Age</th>
            <th className="px-3 py-2 text-right">Codebase Units</th>
            <th className="px-3 py-2 text-right">Graph Edges</th>
          </tr>
        </thead>
        <tbody>
          {repos.map((repo) => (
            <tr key={repo.id} className="border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]">
              <td className="px-3 py-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${healthColors[repo.healthStatus]}`}
                  title={repo.healthStatus}
                />
              </td>
              <td className="px-3 py-2">
                <span className="text-sm font-medium text-[var(--gray-12)]">{repo.name}</span>
              </td>
              <td className="px-3 py-2 font-mono text-xs text-[var(--gray-11)]">
                {repo.lastCommitSha ? repo.lastCommitSha.slice(0, 7) : "—"}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-[var(--gray-11)]">
                {formatAge(repo.stalenessSeconds)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-12)]">
                {repo.codebaseUnits.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs text-[var(--gray-12)]">
                {repo.graphEdges.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
