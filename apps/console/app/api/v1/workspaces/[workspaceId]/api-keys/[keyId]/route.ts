import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  revokeApiKey,
  getApiKey,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; keyId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, keyId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Admin or owner role required" },
      { status: 403 }
    );
  }

  const existing = await getApiKey(workspaceId, keyId);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.revokedAt !== null) {
    return NextResponse.json({ error: "Already revoked" }, { status: 409 });
  }

  const revoked = await revokeApiKey(workspaceId, keyId);
  if (!revoked) {
    return NextResponse.json({ error: "Revoke failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
