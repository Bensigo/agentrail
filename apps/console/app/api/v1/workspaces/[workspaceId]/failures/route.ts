import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";
import { getFailureEvents } from "@agentrail/db-clickhouse";

export async function GET(
  request: Request,
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

  const url = new URL(request.url);
  const severity = url.searchParams.get("severity") ?? undefined;
  const failureType = url.searchParams.get("type") ?? undefined;

  let failures: Awaited<ReturnType<typeof getFailureEvents>> = [];
  try {
    failures = await getFailureEvents(workspaceId, { severity, failureType });
  } catch {
    // ClickHouse may not be available
  }

  return NextResponse.json({ failures });
}
