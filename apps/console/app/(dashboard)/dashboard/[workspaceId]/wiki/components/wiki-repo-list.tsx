"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
// Cross-feature import, deliberate: `add-repository-dialog.tsx` stays at its
// original path — `setup/components/github-step.tsx` (another active
// workstream) imports it from exactly this path too, and that dir is
// off-limits to touch here. This is the ONE management affordance that
// survives the Repos & Health -> Wiki fold (owner ruling); it POSTs to the
// same `.../repos` route it always has, unchanged.
import { AddRepositoryDialog, type RepoRow } from "../../repos/components/add-repository-dialog";
import { formatRelativeAge, shortSha, type RepoListItem } from "../wiki-format";
import type { HealthStatus } from "../../../../../../lib/repo-health";

interface WikiRepoListProps {
  workspaceId: string;
  repos: RepoListItem[];
  selectedId: string | null;
  canManage: boolean;
  onSelect: (id: string) => void;
  onAdded: (repo: RepoListItem) => void;
}

const HEALTH_DOT_CLASS: Record<HealthStatus, string> = {
  healthy: "bg-[var(--green-09)]",
  stale: "bg-[var(--yellow-09)]",
  critical: "bg-[var(--red-09)]",
};

const HEALTH_TEXT_CLASS: Record<HealthStatus, string> = {
  healthy: "text-[var(--green-11)]",
  stale: "text-[var(--yellow-11)]",
  critical: "text-[var(--red-11)]",
};

function repoRowFromApi(repo: RepoRow): RepoListItem {
  return {
    id: repo.id,
    name: repo.name,
    healthStatus: repo.health_status,
    lastIndexedAt: repo.last_indexed_at,
    lastCommitSha: repo.last_commit_sha,
    sourceCount: repo.codebase_units_count !== null ? Number(repo.codebase_units_count) : null,
  };
}

/**
 * The repo list — the health-absorption surface (owner ruling: Repos &
 * Health folded into Wiki, the wiki is now the per-repo evidence page).
 * Replaces the old picker dropdown: every repo's health/last-indexed/
 * commit/source-count is visible at a glance, and a row IS the picker
 * (click to select). "Add repository" is the one write affordance that
 * survives — gated to owner/admin, same as the old repos table. Owns its
 * own "no repos yet" empty state (rather than `wiki-client.tsx` linking to
 * `/repos`, which is now a redirect stub back to `/wiki` — that would bounce).
 */
export function WikiRepoList({
  workspaceId,
  repos,
  selectedId,
  canManage,
  onSelect,
  onAdded,
}: WikiRepoListProps) {
  const [showAdd, setShowAdd] = useState(false);

  function handleAdded(repo: RepoRow) {
    onAdded(repoRowFromApi(repo));
    setShowAdd(false);
  }

  if (repos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded border border-[var(--gray-05)] py-8 text-center">
        <p className="text-sm text-[var(--gray-09)]">No repositories connected yet.</p>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="text-sm text-[var(--blue-11)] hover:underline"
          >
            Add your first repository →
          </button>
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
          Repositories
        </p>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-xs text-[var(--blue-11)] hover:underline"
          >
            <Plus size={12} />
            Add repository
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded border border-[var(--gray-05)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Health
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Repository
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Last Indexed
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Commit
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                Sources
              </th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => {
              const selected = repo.id === selectedId;
              return (
                <tr
                  key={repo.id}
                  onClick={() => onSelect(repo.id)}
                  aria-current={selected ? "true" : undefined}
                  className={`cursor-pointer border-b border-[var(--gray-04)] transition-colors last:border-b-0 ${
                    selected ? "bg-[var(--gray-03)]" : "hover:bg-[var(--gray-02)]"
                  }`}
                  style={{ height: "34px" }}
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT_CLASS[repo.healthStatus]}`}
                        title={repo.healthStatus}
                      />
                      <span className={`text-xs font-medium ${HEALTH_TEXT_CLASS[repo.healthStatus]}`}>
                        {repo.healthStatus}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    {/* UI names over IDs: the repo name, never its id. */}
                    <span
                      className={`text-xs ${selected ? "font-medium text-[var(--gray-12)]" : "text-[var(--gray-11)]"}`}
                    >
                      {repo.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-10)]">
                      {repo.lastIndexedAt ? formatRelativeAge(repo.lastIndexedAt) : "never"}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    {repo.lastCommitSha ? (
                      <span className="font-mono text-xs text-[var(--gray-11)]">
                        {shortSha(repo.lastCommitSha)}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--gray-08)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {repo.sourceCount !== null ? (
                      <span className="font-mono text-xs text-[var(--gray-11)]">
                        {repo.sourceCount.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--gray-08)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
