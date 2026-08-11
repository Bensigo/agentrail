import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, readAcceptanceRecordSummaries } from "@agentrail/db-postgres";
import { parseAcceptanceRecordRepoFilter } from "../../../../../(dashboard)/dashboard/[workspaceId]/components/acceptance-record-summary-list";

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

  const repoValues = request.nextUrl.searchParams.getAll("repo");
  const repoFilter = parseAcceptanceRecordRepoFilter(
    repoValues.length === 0 ? null : repoValues.length === 1 ? repoValues[0] : repoValues,
  );
  if (repoFilter.kind === "invalid") {
    return NextResponse.json({ error: "Invalid repository filter" }, { status: 400 });
  }

  const repo = repoFilter.kind === "valid" ? repoFilter.repo : null;
  const result = await readAcceptanceRecordSummaries({ workspaceId, repo });
  return NextResponse.json(result);
}
