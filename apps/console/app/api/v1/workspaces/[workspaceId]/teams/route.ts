import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listWorkspaceTeams } from "@agentrail/db-postgres";

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

  const teams = await listWorkspaceTeams(workspaceId);

  const result = teams.map((t) => ({
    id: t.id,
    name: t.name,
    created_at: t.createdAt.toISOString(),
    member_count: t.memberCount,
    repositories: t.repositories,
  }));

  return NextResponse.json({ teams: result });
}
