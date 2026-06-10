"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { AddRepositoryDialog, type RepoRow } from "./add-repository-dialog";

type HealthStatus = "healthy" | "stale" | "critical";

interface ReposTableRow {
  id: string;
  name: string;
  defaultBranch: string;
  commitSha: string | null;
  stalenessSeconds: number | null;
  codebageUnitsCount: number | null;
  health: HealthStatus;
}

interface ReposTableProps {
  workspaceId: string;
  initialRows: ReposTableRow[];
  canManage: boolean;
}

const healthDotClass: Record<HealthStatus, string> = {
  healthy: "bg-[#29a383]",
  stale: "bg-[#ffe629]",
  critical: "bg-[#e5484d]",
};

const healthTextClass: Record<HealthStatus, string> = {
  healthy: "text-[#1fd8a4]",
  stale: "text-[#f5e147]",
  critical: "text-[#ff9592]",
};

function formatAge(stalenessSeconds: number | null): string {
  if (stalenessSeconds === null) return "never";
  if (stalenessSeconds < 60) return `${stalenessSeconds}s ago`;
  if (stalenessSeconds < 3600) return `${Math.floor(stalenessSeconds / 60)}m ago`;
  if (stalenessSeconds < 86400) return `${Math.floor(stalenessSeconds / 3600)}h ago`;
  return `${Math.floor(stalenessSeconds / 86400)}d ago`;
}

function repoRowFromApi(repo: RepoRow): ReposTableRow {
  return {
    id: repo.id,
    name: repo.name,
    defaultBranch: repo.default_branch,
    commitSha: repo.last_commit_sha,
    stalenessSeconds: repo.staleness_seconds,
    codebageUnitsCount:
      repo.codebase_units_count !== null ? Number(repo.codebase_units_count) : null,
    health: repo.health_status,
  };
}

export function ReposTable({ workspaceId, initialRows, canManage }: ReposTableProps) {
  const [rows, setRows] = useState<ReposTableRow[]>(initialRows);
  const [showAdd, setShowAdd] = useState(false);

  function handleAdded(repo: RepoRow) {
    setRows((prev) => [repoRowFromApi(repo), ...prev]);
    setShowAdd(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 h-8 px-3 rounded bg-[#ffe629] text-black text-sm font-medium hover:bg-[#ffdc00] transition-colors"
          >
            <Plus size={14} />
            Add repository
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-sm text-[var(--gray-09)]">
          No repositories indexed yet.
          {canManage && (
            <button
              onClick={() => setShowAdd(true)}
              className="mt-2 text-[#70b8ff] hover:underline"
            >
              Add your first repository.
            </button>
          )}
        </div>
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Health
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Repository
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Last Commit
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Index Age
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Codebase Units
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${healthDotClass[row.health]}`}
                        title={row.health}
                      />
                      <span className={`text-xs font-medium ${healthTextClass[row.health]}`}>
                        {row.health}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[var(--gray-12)] font-medium text-xs">
                        {row.name}
                      </span>
                      <span className="font-mono text-xs text-[var(--gray-09)]">
                        {row.defaultBranch}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    {row.commitSha ? (
                      <span className="font-mono text-xs text-[var(--gray-11)]">
                        {row.commitSha.slice(0, 8)}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--gray-08)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-10)]">
                      {formatAge(row.stalenessSeconds)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    {row.codebageUnitsCount !== null ? (
                      <span className="font-mono text-xs text-[var(--gray-11)]">
                        {row.codebageUnitsCount.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--gray-08)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddRepositoryDialog
          workspaceId={workspaceId}
          onAdded={handleAdded}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
