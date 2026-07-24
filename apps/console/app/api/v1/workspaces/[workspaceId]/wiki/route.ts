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
 * the now-redirected `.../repos/route.ts` exactly). Read-only for the wiki
 * itself — there is no POST here; the view's write affordances are the
 * existing re-index mechanism reused as-is by the client (`recompile-button.tsx`)
 * and the existing repo-connect POST `.../repos` (unchanged, still called
 * directly by `AddRepositoryDialog`) — never a new write route.
 *
 * Repo resolution: `?repoId=` selects a repo explicitly; omitted, a
 * single-repo workspace auto-selects (spec §4.5 "repo picker ... single-repo
 * workspaces auto-select"); a multi-repo workspace with no `repoId` yet gets
 * the repo list only (`pages`/`latestCompile` both null) so the client can
 * render the list before committing to a second round trip.
 *
 * Repos & Health absorption (owner ruling): every response branch now
 * includes the FULL per-repo health list (health status, last-indexed age,
 * commit sha, source count) — mirroring the health computation the
 * now-redirected `/repos` page and its API route used
 * (`getLatestIndexSnapshotsForWorkspace` + `repoHealth`, the single source of
 * truth in `lib/repo-health.ts`) — plus `canManage`, so the client can gate
 * the "Add repository" affordance the same way `repos-table.tsx` did.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
  getRepository,
  listWikiPages,
} from "@agentrail/db-postgres";
import {
  getLatestWikiCompileEvent,
  getLatestIndexSnapshotsForWorkspace,
  type IndexSnapshotRecord,
} from "@agentrail/db-clickhouse";
import { repoHealth } from "../../../../../../lib/repo-health";

const ADMIN_ROLES = new Set(["owner", "admin"]);

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
  const canManage = ADMIN_ROLES.has(membership.role);

  const requestedRepoId =
    new URL(request.url).searchParams.get("repoId")?.trim() || null;

  try {
    const repoRows = await listWorkspaceRepositories(workspaceId);
    const repoIds = repoRows.map((r) => r.id);

    // Best-effort — an outage must not take down the repo list or the wiki
    // body, same posture as the now-redirected repos page's own lookup.
    let snapshots: IndexSnapshotRecord[] = [];
    try {
      snapshots = await getLatestIndexSnapshotsForWorkspace(workspaceId, repoIds);
    } catch (err) {
      console.error("[workspaces/wiki] index-snapshot lookup failed:", err);
    }
    const snapshotByRepo = new Map(snapshots.map((s) => [s.repository_id, s]));
    const now = Date.now();

    const repos = repoRows.map((r) => {
      const snap = snapshotByRepo.get(r.id) ?? null;
      const health = repoHealth(snap, now);
      return {
        id: r.id,
        name: r.name,
        healthStatus: health.health_status,
        lastIndexedAt: health.last_indexed_at,
        lastCommitSha: snap?.commit_sha ?? null,
        sourceCount: snap ? Number(snap.source_count) : null,
      };
    });

    const resolvedRepoId =
      requestedRepoId ?? (repos.length === 1 ? repos[0]!.id : null);

    if (!resolvedRepoId) {
      return NextResponse.json({
        repos,
        canManage,
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
    // an outage must not take down the wiki body itself.
    let latestCompile: Awaited<ReturnType<typeof getLatestWikiCompileEvent>> = null;
    try {
      latestCompile = await getLatestWikiCompileEvent(workspaceId, repo.id);
    } catch (err) {
      console.error("[workspaces/wiki] ClickHouse compile-event lookup failed:", err);
    }

    return NextResponse.json({
      repos,
      canManage,
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
        // Opaque, compiler-owned deterministic inputs (file roster, unit
        // path, exports, dependency edges) — passed through as-is so the
        // client can render the file-structure nav grouping and the
        // per-page file-roster tree from STRUCTURED data, never by parsing
        // `bodyMd`. The compiler (spec PR 2) hasn't shipped yet, so real
        // rows have no `path`/`files` today — every reader of this field
        // must degrade gracefully (flat fallback / omit the block), never
        // assume a shape.
        skeleton: p.skeleton,
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
