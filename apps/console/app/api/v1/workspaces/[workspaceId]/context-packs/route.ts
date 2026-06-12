import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listRuns,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";
import { listWorkspaceContextPacks } from "@agentrail/db-clickhouse";

export async function GET(
  request: NextRequest,
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

  const searchParams = request.nextUrl.searchParams;
  const cursor = searchParams.get("cursor") ?? undefined;
  const limitParam = Number(searchParams.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, 100)
      : 50;

  try {
    const { packs, nextCursor } = await listWorkspaceContextPacks(workspaceId, {
      cursor,
      limit,
    });

    // Enrich with run title/status and repository name from Postgres. A
    // failure here degrades the rows to run-id prefixes rather than failing
    // the request.
    const runsById = new Map<
      string,
      { title: string | null; status: string; repositoryId: string }
    >();
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

    const serialized = packs.map((p) => {
      const run = runsById.get(p.run_id);
      const repoName = run
        ? repoNameById.get(run.repositoryId) ?? run.repositoryId
        : null;
      return {
        context_pack_id: p.context_pack_id,
        run_id: p.run_id,
        run_title: run?.title ?? null,
        run_status: run?.status ?? null,
        repository_name: repoName,
        token_budget: p.token_budget,
        tokens_used: p.tokens_used,
        tokens_saved: p.tokens_saved,
        anchors_extracted: p.anchors_extracted,
        sources_considered: p.sources_considered,
        occurred_at: p.occurred_at.toISOString(),
      };
    });

    return NextResponse.json({ packs: serialized, nextCursor });
  } catch (err) {
    console.error("[workspaces/context-packs] ClickHouse query failed:", err);
    return NextResponse.json(
      { error: "Failed to load context packs" },
      { status: 500 }
    );
  }
}
