import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listTeams, getTeamMemberCounts } from "@agentrail/db-postgres";

export async function GET(
  _request: Request,
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

  const teamsList = await listTeams(workspaceId);
  const counts = await getTeamMemberCounts(teamsList.map((t) => t.id));

  const enriched = teamsList.map((team) => ({
    ...team,
    memberCount: counts.get(team.id) ?? 0,
  }));

  return NextResponse.json({ teams: enriched });
}
