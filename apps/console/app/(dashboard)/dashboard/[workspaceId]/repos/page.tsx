import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listWorkspaceRepositories } from "@agentrail/db-postgres";
import { getLatestIndexSnapshotsForWorkspace } from "@agentrail/db-clickhouse";
import type { IndexSnapshotRecord } from "@agentrail/db-clickhouse";
import { ReposTable } from "./components/repos-table";

type HealthStatus = "healthy" | "stale" | "critical";

function computeHealth(stalenessSeconds: number | null): HealthStatus {
  if (stalenessSeconds === null) return "critical";
  if (stalenessSeconds < 3600) return "healthy";
  if (stalenessSeconds < 86400) return "stale";
  return "critical";
}

export default async function ReposPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await auth();
  const userId = session?.user?.id ?? null;

  let canManage = false;
  let repos: Awaited<ReturnType<typeof listWorkspaceRepositories>> = [];

  if (userId) {
    try {
      const membership = await getWorkspaceMembership(userId, workspaceId);
      if (membership) {
        canManage = membership.role === "owner" || membership.role === "admin";
        repos = await listWorkspaceRepositories(workspaceId);
      }
    } catch {
      // DB unavailable
    }
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
      // ClickHouse DateTime64 comes back as "YYYY-MM-DD HH:MM:SS.mmm" in UTC with
      // no tz marker; new Date() parses that as LOCAL time and inflates staleness
      // by the server's UTC offset, making fresh snapshots read "stale".
      const toUtc = (s: string): Date =>
        /[zZ]|[+-]\d\d:?\d\d$/.test(s)
          ? new Date(s)
          : new Date(s.replace(" ", "T") + "Z");
      const indexedDate =
        typeof snap.indexed_at === "string"
          ? toUtc(snap.indexed_at)
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
      <ReposTable
        workspaceId={workspaceId}
        initialRows={rows}
        canManage={canManage}
      />
    </div>
  );
}
