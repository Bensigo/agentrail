import { Suspense } from "react";
import { listWorkspaceRepositories } from "@agentrail/db-postgres";
import { getLatestIndexSnapshotsForWorkspace } from "@agentrail/db-clickhouse";
import type { IndexSnapshotRecord } from "@agentrail/db-clickhouse";
import { ReposTable } from "./components/repos-table";
import { SkeletonTable } from "../../../../components/loading-skeleton";
import { repoHealth } from "../../../../../lib/repo-health";
import { getMembership, getSession } from "../../../../../lib/cached";

// Streams in behind Suspense so the page shell paints immediately while the
// membership/repo/snapshot lookups resolve.
async function ReposSection({ workspaceId }: { workspaceId: string }) {
  const session = await getSession();
  const userId = session?.user?.id ?? null;

  let canManage = false;
  let repos: Awaited<ReturnType<typeof listWorkspaceRepositories>> = [];

  if (userId) {
    // Membership and the repo list are independent lookups — run them in
    // parallel and only use the repos if the membership check passes.
    const [membership, repoRows] = await Promise.all([
      getMembership(userId, workspaceId).catch(() => null),
      listWorkspaceRepositories(workspaceId).catch(() => null),
    ]);
    if (membership) {
      canManage = membership.role === "owner" || membership.role === "admin";
      repos = repoRows ?? [];
    }
  }

  // Snapshots depend on the repo ids, so they stay sequential.
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
    const health = repoHealth(snap, now);

    return {
      id: repo.id,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      commitSha: snap?.commit_sha ?? null,
      stalenessSeconds: health.staleness_seconds,
      codebageUnitsCount: snap ? Number(snap.source_count) : null,
      health: health.health_status,
    };
  });

  return (
    <ReposTable workspaceId={workspaceId} initialRows={rows} canManage={canManage} />
  );
}

export default async function ReposPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Repos &amp; Health
      </h1>
      <Suspense fallback={<SkeletonTable columns={6} rows={6} />}>
        <ReposSection workspaceId={workspaceId} />
      </Suspense>
    </div>
  );
}
