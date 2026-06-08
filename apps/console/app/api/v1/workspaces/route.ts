import { NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { listWorkspacesForUser } from "@agentrail/db-postgres";

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as typeof session.user & { id?: string }).id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspaces = await listWorkspacesForUser(userId);

  return NextResponse.json(
    workspaces.map(({ id, name, slug, role }) => ({ id, name, slug, role }))
  );
}
