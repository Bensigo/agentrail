import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, getReviewGatesForRun } from "@agentrail/db-postgres";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, runId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const gates = await getReviewGatesForRun(workspaceId, runId);
    return NextResponse.json({ gates });
  } catch {
    return NextResponse.json({ gates: [] });
  }
}
