import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listChangeRecords } from "@agentrail/db-postgres";

function serializeRecord(record: Awaited<ReturnType<typeof listChangeRecords>>[number]) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    repo: record.repo,
    issueNumber: record.issueNumber,
    prNumber: record.prNumber,
    headShas: record.headShas,
    mergedSha: record.mergedSha,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

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

  const repo = request.nextUrl.searchParams.get("repo")?.trim() || null;
  const records = await listChangeRecords({ workspaceId, repo });
  return NextResponse.json({ records: records.map(serializeRecord), repo });
}
