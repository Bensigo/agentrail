import { listWorkspaceRepositories } from "@agentrail/db-postgres";
import { getLatestIndexSnapshotsForWorkspace } from "@agentrail/db-clickhouse";
import type { IndexSnapshotRecord } from "@agentrail/db-clickhouse";

type HealthStatus = "healthy" | "stale" | "critical";

function computeHealth(stalenessSeconds: number | null): HealthStatus {
  if (stalenessSeconds === null) return "critical";
  if (stalenessSeconds < 3600) return "healthy";
  if (stalenessSeconds < 86400) return "stale";
  return "critical";
}

function formatAge(stalenessSeconds: number | null): string {
  if (stalenessSeconds === null) return "never";
  if (stalenessSeconds < 60) return `${stalenessSeconds}s ago`;
  if (stalenessSeconds < 3600) return `${Math.floor(stalenessSeconds / 60)}m ago`;
  if (stalenessSeconds < 86400) return `${Math.floor(stalenessSeconds / 3600)}h ago`;
  return `${Math.floor(stalenessSeconds / 86400)}d ago`;
}

const healthDotClass: Record<HealthStatus, string> = {
  healthy: "bg-[#29a383]",
  stale: "bg-[#ffe629]",
  critical: "bg-[#e5484d]",
};

const healthLabel: Record<HealthStatus, string> = {
  healthy: "healthy",
  stale: "stale",
  critical: "critical",
};

export default async function ReposPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  let repos: Awaited<ReturnType<typeof listWorkspaceRepositories>> = [];
  try {
    repos = await listWorkspaceRepositories(workspaceId);
  } catch {
    // DB unavailable
  }

  const repoIds = repos.map((r) => r.id);
  let snapshots: IndexSnapshotRecord[] = [];
  try {
    snapshots = await getLatestIndexSnapshotsForWorkspace(workspaceId, repoIds);
  } catch {
    // ClickHouse unavailable
  }

  const snapshotByRepo = new Map(snapshots.map((s) => [s.repository_id, s]));
  const now = Date.now();

  const rows = repos.map((repo) => {
    const snap = snapshotByRepo.get(repo.id) ?? null;
    let stalenessSeconds: number | null = null;

    if (snap) {
      const indexedDate =
        typeof snap.indexed_at === "string"
          ? new Date(snap.indexed_at)
          : snap.indexed_at;
      stalenessSeconds = Math.floor((now - indexedDate.getTime()) / 1000);
    }

    return {
      id: repo.id,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      commitSha: snap?.commit_sha ?? null,
      stalenessSeconds,
      codebageUnitsCount: snap ? Number(snap.source_count) : null,
      health: computeHealth(stalenessSeconds),
    };
  });

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Repos &amp; Health
      </h1>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-sm text-[var(--gray-09)]">
          No repositories indexed yet.
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
                        title={healthLabel[row.health]}
                      />
                      <span
                        className={`text-xs font-medium ${
                          row.health === "healthy"
                            ? "text-[#1fd8a4]"
                            : row.health === "stale"
                              ? "text-[#f5e147]"
                              : "text-[#ff9592]"
                        }`}
                      >
                        {healthLabel[row.health]}
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
    </div>
  );
}
