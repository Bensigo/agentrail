import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceMembers,
} from "@agentrail/db-postgres";

export async function GET(
  _request: NextRequest,
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

  const members = await listWorkspaceMembers(workspaceId);

  return NextResponse.json({
    caller_role: membership.role,
    members: members.map((m) => ({
      user_id: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      joined_at: m.joinedAt.toISOString(),
    })),
  });
}
