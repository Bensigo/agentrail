/**
 * POST /api/v1/workspaces/:workspaceId/wiki/recompile
 *
 * The REAL "Recompile" affordance (Repo Wiki spec §4.5 — owner ruling: "I
 * expect it to happen on its own"). Before this route existed, the console's
 * `RecompileButton` could only show a copy-paste `agentrail context index`
 * CLI command — there was no write route that let an ALREADY-connected
 * repo's onboard job be re-enqueued (see that component's prior doc-comment
 * for the full history). This route is that missing enqueue: session-authed,
 * workspace-membership-scoped, owner/admin-gated — mirrors `.../repos`
 * POST's auth pattern (the Add-repo affordance) and
 * `.../queue/[queueEntryId]/requeue`'s "force a queue entry back to queued"
 * shape exactly. Queue-driven and audited like every other admission path in
 * this file's sibling routes — no direct console-to-LLM call happens here.
 *
 * Body: `{ repoFullName: string }` — resolved to a `repositories` row WITHIN
 * this workspace (never trusts an arbitrary caller-supplied string into the
 * queue — the same "no cross-workspace existence oracle" posture
 * `GET .../wiki` already documents for `repoId`).
 *
 * `enqueueOnboard(..., { force: true })` re-arms the repo's existing
 * onboard-kind queue entry even though it is normally a permanent one-shot
 * dedupe (see that function's own doc-comment) — that re-arm is what makes
 * this button do something on the SECOND and every subsequent click, not
 * just the first.
 *
 * Responses:
 *  - 202 `{ status: "queued" }` — a fresh onboard run was actually admitted
 *    (the repo's first-ever onboard, or a force-rearm of its prior terminal
 *    row).
 *  - 202 `{ status: "already_pending" }` — the repo's onboard row is
 *    ALREADY active (queued or running); nothing new was inserted. Reported
 *    honestly rather than claiming "queued" for a write that never happened.
 *  - 400 — missing `repoFullName`.
 *  - 401/403 — unauthenticated / not a member / not owner-or-admin.
 *  - 404 — `repoFullName` does not resolve to a repository in this
 *    workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  getRepositoryByName,
  enqueueOnboard,
  ONBOARD_ALREADY_PENDING_REASON,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = new Set(["owner", "admin"]);

export async function POST(
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
  if (!ADMIN_ROLES.has(membership.role)) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    repoFullName?: unknown;
  };
  const repoFullName =
    typeof body.repoFullName === "string" ? body.repoFullName.trim() : "";
  if (!repoFullName) {
    return NextResponse.json(
      { error: "repoFullName is required" },
      { status: 400 }
    );
  }

  const repo = await getRepositoryByName(workspaceId, repoFullName);
  if (!repo) {
    return NextResponse.json(
      { error: "Repository not found in this workspace" },
      { status: 404 }
    );
  }

  let result;
  try {
    result = await enqueueOnboard({
      workspaceId,
      repoFullName: repo.name,
      force: true,
    });
  } catch (err) {
    console.error("[wiki/recompile] enqueueOnboard failed:", err);
    return NextResponse.json(
      { error: "Failed to enqueue recompile" },
      { status: 500 }
    );
  }

  if (result.enqueued) {
    return NextResponse.json({ status: "queued" }, { status: 202 });
  }
  if (result.reason === ONBOARD_ALREADY_PENDING_REASON) {
    return NextResponse.json({ status: "already_pending" }, { status: 202 });
  }
  // Defensive: force:true always takes either the "enqueued" or
  // "already_pending" branch in enqueueOnboard — any other reason is
  // unreachable in practice, but never silently fabricate "queued" for a
  // write that didn't happen.
  console.error("[wiki/recompile] unexpected enqueueOnboard reason:", result.reason);
  return NextResponse.json(
    { error: "Failed to enqueue recompile" },
    { status: 500 }
  );
}
