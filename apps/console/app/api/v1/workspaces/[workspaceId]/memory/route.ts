import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listMemoryItems } from "@agentrail/db-postgres";

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

  try {
    const items = await listMemoryItems(workspaceId);
    const serialized = items.map((item) => ({
      id: item.id,
      source: item.source,
      repository_name: item.repositoryName,
      content_preview: item.content.slice(0, 200),
      content: item.content,
      tags: item.tags,
      created_at: item.createdAt.toISOString(),
      last_used_at: item.lastUsedAt ? item.lastUsedAt.toISOString() : null,
    }));
    return NextResponse.json({ items: serialized });
  } catch (err) {
    console.error("[workspaces/memory] Postgres query failed:", err);
    return NextResponse.json(
      { error: "Failed to load memory items" },
      { status: 500 }
    );
  }
}
