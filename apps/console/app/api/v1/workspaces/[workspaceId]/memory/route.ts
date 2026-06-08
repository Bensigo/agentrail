import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, listMemoryItems } from "@agentrail/db-postgres";

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

  const items = await listMemoryItems(workspaceId);
  return NextResponse.json({
    items: items.map((item) => ({
      ...item,
      contentPreview: item.content.slice(0, 200),
    })),
  });
}
