import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listReviewGatesForWorkspace } from "@agentrail/db-postgres";

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

  const runId = request.nextUrl.searchParams.get("runId") ?? undefined;

  try {
    const gates = await listReviewGatesForWorkspace(workspaceId, runId);
    return NextResponse.json({ gates });
  } catch {
    return NextResponse.json({ gates: [] });
  }
}
