import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  createInvite,
  listInvites,
} from "@agentrail/db-postgres";

const ADMIN_ROLES = ["owner", "admin"] as const;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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

  const invites = await listInvites(workspaceId);

  return NextResponse.json({
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      token: i.token,
      status: i.status,
      invited_by_user_id: i.invitedByUserId,
      created_at: i.createdAt.toISOString(),
      expires_at: i.expiresAt.toISOString(),
    })),
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
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    role?: string;
  };

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { error: "Valid email is required" },
      { status: 400 }
    );
  }

  if (body.role === "owner") {
    return NextResponse.json(
      { error: "Cannot invite with owner role" },
      { status: 400 }
    );
  }

  const role =
    body.role === "admin" || body.role === "member" || body.role === "viewer"
      ? body.role
      : "member";

  const invite = await createInvite({
    workspaceId,
    email,
    role,
    invitedByUserId: session.user.id,
  });

  return NextResponse.json(
    {
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        token: invite.token,
        status: invite.status,
        invited_by_user_id: invite.invitedByUserId,
        created_at: invite.createdAt.toISOString(),
        expires_at: invite.expiresAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
