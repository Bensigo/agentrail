import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaces = await listWorkspacesForUser(session.user.id);
  return NextResponse.json({ workspaces });
}
