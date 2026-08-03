import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  createDependencyWatch,
  DependencyWatchAuthorizationError,
  DependencyWatchValidationError,
  getWorkspaceMembership,
  listDependencyWatches,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = new Set(["owner", "admin"]);

async function workspaceAccess(userId: string, workspaceId: string) {
  return getWorkspaceMembership(userId, workspaceId);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  if (!(await workspaceAccess(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ watches: await listDependencyWatches(workspaceId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const membership = await workspaceAccess(session.user.id, workspaceId);
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!ADMIN_ROLES.has(membership.role)) {
    return NextResponse.json({ error: "Owner or admin role required" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const repositoryId = typeof body.repository_id === "string" ? body.repository_id : "";
  const manifestPath = typeof body.manifest_path === "string" ? body.manifest_path : undefined;
  const lockfilePath = typeof body.lockfile_path === "string" ? body.lockfile_path : undefined;
  const selectedDependencies = Array.isArray(body.dependencies)
    ? body.dependencies.filter((value): value is string => typeof value === "string")
    : undefined;
  const cadenceSeconds =
    body.cadence_seconds === null || body.cadence_seconds === undefined
      ? body.cadence_seconds
      : typeof body.cadence_seconds === "number"
        ? body.cadence_seconds
        : NaN;

  try {
    const watch = await createDependencyWatch({
      workspaceId,
      repositoryId,
      manifestPath,
      lockfilePath,
      selectedDependencies,
      cadenceSeconds,
    });
    return NextResponse.json({ watch }, { status: 201 });
  } catch (error) {
    if (error instanceof DependencyWatchAuthorizationError) {
      return NextResponse.json({ error: "Repository is not connected to this workspace" }, { status: 403 });
    }
    if (error instanceof DependencyWatchValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[dependency-watches] create failed:", error);
    return NextResponse.json({ error: "Failed to configure dependency watch" }, { status: 500 });
  }
}
