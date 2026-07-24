/**
 * GET /api/v1/workspaces/:workspaceId/wiki?repoId=<optional>
 *
 * Session-authed read surface for the console's Engine-room Wiki view (Repo
 * Wiki spec §4.5, delivery plan §7 row 6). This is deliberately a SEPARATE
 * route from `GET /api/v1/context/wiki-pages` (PR 4): that one is bearer-authed
 * for the factory's hydration client and returns content unmasked for a
 * machine caller; this one is cookie/session-authed for a human browsing the
 * dashboard, scoped by workspace membership like every other
 * `workspaces/[workspaceId]/*` route (mirrors `.../memory/route.ts` and
 * `.../repos/route.ts` exactly). Read-only — there is no POST here; the
 * view's only write affordance is the existing re-index mechanism reused
 * as-is by the client (see `recompile-command.tsx`), never a new route.
 *
 * Repo resolution: `?repoId=` selects a repo explicitly; omitted, a
 * single-repo workspace auto-selects (spec §4.5 "repo picker ... single-repo
 * workspaces auto-select"); a multi-repo workspace with no `repoId` yet gets
 * the picker list only (`pages`/`latestCompile` both null) so the client can
 * render the picker before committing to a second round trip.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  getRepository,
  listWikiPages,
} from "@agentrail/db-postgres";
import { getLatestWikiCompileEvent } from "@agentrail/db-clickhouse";

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

  const requestedRepoId =
    new URL(request.url).searchParams.get("repoId")?.trim() || null;

  try {
    const repoRows = await listWorkspaceRepositories(workspaceId);
    const repos = repoRows.map((r) => ({ id: r.id, name: r.name }));

    const resolvedRepoId =
      requestedRepoId ?? (repos.length === 1 ? repos[0]!.id : null);

    if (!resolvedRepoId) {
      return NextResponse.json({
        repos,
        selectedRepoId: null,
        repoUrl: null,
        pages: null,
        latestCompile: null,
      });
    }

    // Workspace-scoped lookup — a repoId from another workspace reads as
    // not-found, same posture as `context/wiki-pages`' "no cross-workspace
    // existence oracle" comment.
    const repo = await getRepository(workspaceId, resolvedRepoId);
    if (!repo) {
      return NextResponse.json(
        { error: "Repository not found in this workspace" },
        { status: 404 }
      );
    }

    const pageRows = await listWikiPages(workspaceId, repo.id);

    // ClickHouse is a best-effort read for the provenance bar's cost line —
    // an outage must not take down the wiki body itself, same posture as the
    // repos page's `getLatestIndexSnapshotsForWorkspace` lookup.
    let latestCompile: Awaited<ReturnType<typeof getLatestWikiCompileEvent>> = null;
    try {
      latestCompile = await getLatestWikiCompileEvent(workspaceId, repo.id);
    } catch (err) {
      console.error("[workspaces/wiki] ClickHouse compile-event lookup failed:", err);
    }

    return NextResponse.json({
      repos,
      selectedRepoId: repo.id,
      repoUrl: repo.url,
      pages: pageRows.map((p) => ({
        slug: p.slug,
        title: p.title,
        kind: p.kind,
        bodyMd: p.bodyMd,
        citations: p.citations,
        links: p.links,
        commitSha: p.commitSha,
        model: p.model,
        generatedAt: p.generatedAt.toISOString(),
        stale: p.stale,
      })),
      latestCompile: latestCompile
        ? {
            commitSha: latestCompile.commit_sha,
            pagesWritten: latestCompile.pages_written,
            pagesReused: latestCompile.pages_reused,
            costUsd: latestCompile.cost_usd,
            model: latestCompile.model,
            durationMs: latestCompile.duration_ms,
            createdAt: new Date(latestCompile.created_at).toISOString(),
          }
        : null,
    });
  } catch (err) {
    console.error("[workspaces/wiki] query failed:", err);
    return NextResponse.json({ error: "Failed to load wiki" }, { status: 500 });
  }
}
