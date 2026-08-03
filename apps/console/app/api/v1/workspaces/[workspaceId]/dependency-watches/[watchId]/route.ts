import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  DependencyWatchAuthorizationError,
  DependencyWatchValidationError,
  getDependencyWatch,
  getWorkspaceMembership,
  triggerDependencyWatch,
} from "@agentrail/db-postgres";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; watchId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, watchId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const watch = await getDependencyWatch(workspaceId, watchId);
  return watch
    ? NextResponse.json({ watch })
    : NextResponse.json({ error: "Dependency watch not found" }, { status: 404 });
}

/** Explicit manual observation trigger. It records intent for the heartbeat;
 * it never admits executable work or creates an approval. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; watchId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, watchId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.trigger !== undefined && body.trigger !== "manual") {
    return NextResponse.json({ error: "Only the manual trigger is accepted here" }, { status: 400 });
  }
  try {
    const watch = await triggerDependencyWatch(workspaceId, watchId, "manual");
    return NextResponse.json({ watch, dispatched: true }, { status: 202 });
  } catch (error) {
    if (error instanceof DependencyWatchAuthorizationError) {
      return NextResponse.json({ error: "Dependency watch not found" }, { status: 404 });
    }
    if (error instanceof DependencyWatchValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[dependency-watches] manual trigger failed:", error);
    return NextResponse.json({ error: "Failed to trigger dependency watch" }, { status: 500 });
  }
}
