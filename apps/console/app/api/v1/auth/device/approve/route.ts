import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { approveDeviceCode, listWorkspacesForUser } from "@agentrail/db-postgres";

/**
 * Approve a pending device code (session-authenticated, NOT bearer). The
 * logged-in operator submits the short `user_code` shown by their runner; we
 * resolve their workspace from the session and mark the code approved for it.
 * The runner token is minted lazily on the next /token poll.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    user_code?: string;
  };
  const userCode = typeof body.user_code === "string" ? body.user_code.trim() : "";
  if (!userCode) {
    return NextResponse.json({ error: "user_code is required" }, { status: 400 });
  }

  // Resolve the operator's workspace from the session. The runner is bound to
  // the operator's (first) workspace — the same convention the root dashboard
  // redirect uses to pick a default workspace.
  const workspaces = await listWorkspacesForUser(session.user.id);
  const workspace = workspaces[0];
  if (!workspace) {
    return NextResponse.json(
      { error: "You must belong to a workspace to authorize a runner." },
      { status: 403 }
    );
  }

  const result = await approveDeviceCode({
    userCode,
    workspaceId: workspace.id,
  });

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json(
        { error: "That code wasn't found. Check it and try again." },
        { status: 404 }
      );
    }
    if (result.reason === "expired") {
      return NextResponse.json(
        { error: "That code has expired. Start the runner again for a new code." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "That code has already been used." },
      { status: 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    workspace_id: workspace.id,
    workspace_name: workspace.name,
  });
}
