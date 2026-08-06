import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, revokeAgentMcpApiKey } from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; keyId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, keyId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Admin or owner role required" }, { status: 403 });
  }
  const revoked = await revokeAgentMcpApiKey(workspaceId, keyId);
  if (!revoked) return NextResponse.json({ error: "Credential not found or already revoked" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
