import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";
import { getLatestIndexSnapshotsForWorkspace } from "@agentrail/db-clickhouse";

type HealthStatus = "healthy" | "stale" | "critical";

function computeHealth(stalenessSeconds: number | null): HealthStatus {
  if (stalenessSeconds === null) return "critical";
  if (stalenessSeconds < 3600) return "healthy";
  if (stalenessSeconds < 86400) return "stale";
  return "critical";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const repos = await listWorkspaceRepositories(workspaceId);
  const repoIds = repos.map((r) => r.id);

  let snapshots: Awaited<ReturnType<typeof getLatestIndexSnapshotsForWorkspace>> = [];
  try {
    snapshots = await getLatestIndexSnapshotsForWorkspace(workspaceId, repoIds);
  } catch {
    // ClickHouse unavailable — return repos with critical health
  }

  const snapshotByRepo = new Map(snapshots.map((s) => [s.repository_id, s]));
  const now = Date.now();

  const result = repos.map((repo) => {
    const snap = snapshotByRepo.get(repo.id) ?? null;
    let lastIndexedAt: string | null = null;
    let stalenessSeconds: number | null = null;

    if (snap) {
      const indexedDate =
        typeof snap.indexed_at === "string"
          ? new Date(snap.indexed_at)
          : snap.indexed_at;
      lastIndexedAt = indexedDate.toISOString();
      stalenessSeconds = Math.floor((now - indexedDate.getTime()) / 1000);
    }

    return {
      id: repo.id,
      name: repo.name,
      url: repo.url,
      default_branch: repo.defaultBranch,
      last_indexed_at: lastIndexedAt,
      last_commit_sha: snap?.commit_sha ?? null,
      staleness_seconds: stalenessSeconds,
      codebase_units_count: snap?.source_count ?? null,
      health_status: computeHealth(stalenessSeconds),
    };
  });

  return NextResponse.json({ repos: result });
}
