import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getReviewGate, getWorkspaceMembership } from "@agentrail/db-postgres";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; gateId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, gateId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const gate = await getReviewGate(workspaceId, gateId);
    if (!gate) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ gate });
  } catch (err) {
    console.error("[review-gates] failed to load gate:", err);
    return NextResponse.json({ error: "Failed to load review gate" }, { status: 500 });
  }
}
