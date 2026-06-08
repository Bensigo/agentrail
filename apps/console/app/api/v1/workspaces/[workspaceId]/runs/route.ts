import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listRuns } from "@agentrail/db-postgres";

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

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status") as
    | "queued"
    | "running"
    | "success"
    | "failed"
    | null;
  const agent = searchParams.get("agent");
  const limit = Math.min(
    parseInt(searchParams.get("limit") ?? "50", 10),
    100
  );

  const runs = await listRuns(workspaceId, {
    status: status ?? undefined,
    agent: agent ?? undefined,
    limit,
  });

  return NextResponse.json({ runs });
}
