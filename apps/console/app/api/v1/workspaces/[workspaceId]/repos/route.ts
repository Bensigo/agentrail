import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRepositories } from "@agentrail/db-postgres";
import { getLatestIndexSnapshots } from "@agentrail/db-clickhouse";

export async function GET(
  _request: Request,
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

  const repos = await listRepositories(workspaceId);

  let snapshots: Awaited<ReturnType<typeof getLatestIndexSnapshots>> = [];
  try {
    snapshots = await getLatestIndexSnapshots(workspaceId);
  } catch {
    // ClickHouse may not be available
  }

  const snapshotMap = new Map(snapshots.map((s) => [s.repository_id, s]));
  const now = Date.now();

  const enriched = repos.map((repo) => {
    const snap = snapshotMap.get(repo.id);
    let healthStatus: "healthy" | "stale" | "critical" = "critical";
    let stalenessSeconds = -1;

    if (snap) {
      stalenessSeconds = Math.floor((now - new Date(snap.indexed_at).getTime()) / 1000);
      if (stalenessSeconds < 3600) healthStatus = "healthy";
      else if (stalenessSeconds < 86400) healthStatus = "stale";
      else healthStatus = "critical";
    }

    return {
      ...repo,
      lastCommitSha: snap?.commit_sha ?? null,
      lastIndexedAt: snap?.indexed_at ?? null,
      stalenessSeconds,
      codebaseUnits: snap?.source_count ?? 0,
      graphEdges: snap?.graph_edge_count ?? 0,
      healthStatus,
    };
  });

  return NextResponse.json({ repos: enriched });
}
