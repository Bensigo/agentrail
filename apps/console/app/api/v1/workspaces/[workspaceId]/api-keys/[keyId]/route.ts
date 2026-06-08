import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, revokeApiKey } from "@agentrail/db-postgres";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string; keyId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, keyId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await revokeApiKey(workspaceId, keyId);
  return NextResponse.json({ ok: true });
}
