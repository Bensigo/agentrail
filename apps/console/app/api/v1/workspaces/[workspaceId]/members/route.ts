import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceMembers,
  findUserByEmail,
  addWorkspaceMember,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

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

  const members = await listWorkspaceMembers(workspaceId);

  return NextResponse.json({
    members: members.map((m) => ({
      user_id: m.userId,
      email: m.email,
      name: m.name,
      role: m.role,
      joined_at: m.joinedAt.toISOString(),
    })),
    caller_role: membership.role,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const callerMembership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!callerMembership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(callerMembership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { email?: string; role?: string };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const role = body.role;

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (role !== "member" && role !== "admin") {
    return NextResponse.json(
      { error: "role must be 'member' or 'admin'" },
      { status: 400 }
    );
  }

  // Admins cannot grant admin role — only owners can
  if (role === "admin" && callerMembership.role !== "owner") {
    return NextResponse.json(
      { error: "Only owners can grant the admin role" },
      { status: 403 }
    );
  }

  const targetUser = await findUserByEmail(email);
  if (!targetUser) {
    return NextResponse.json(
      {
        error: "no_user",
        message: "No AgentRail user with that email. Ask them to sign in with GitHub first.",
      },
      { status: 404 }
    );
  }

  const existingMembership = await getWorkspaceMembership(targetUser.id, workspaceId);
  if (existingMembership) {
    return NextResponse.json(
      { error: "already_member" },
      { status: 409 }
    );
  }

  const newMembership = await addWorkspaceMember({
    userId: targetUser.id,
    workspaceId,
    role,
  });

  return NextResponse.json(
    {
      member: {
        user_id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        role: newMembership.role,
        joined_at: newMembership.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
