import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listMemoryItemsByRunId } from "@agentrail/db-postgres";

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
    const items = await listMemoryItemsByRunId(workspaceId, runId);
    const serialized = items.map((item) => ({
      id: item.id,
      source: item.source,
      content_preview: item.content.slice(0, 200),
      content: item.content,
      tags: item.tags,
      created_at: item.createdAt.toISOString(),
      last_used_at: item.lastUsedAt ? item.lastUsedAt.toISOString() : null,
    }));
    return NextResponse.json({ items: serialized });
  } catch {
    // A 200 with no items would make a DB outage indistinguishable from a
    // run that simply produced no memory; surface the failure instead.
    return NextResponse.json(
      { error: "Failed to load memory items" },
      { status: 500 }
    );
  }
}
