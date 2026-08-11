import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { getWorkspaceMembership } from "@agentrail/db-postgres";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * Browser-side publication is disabled. The existing detail read model stays
 * intact, but the sole write path is Jace's human-approved `create_issue`
 * correction mode, which mints its request from an Eve session.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id || !UUID.test(session.user.id)) {
    void request.body?.cancel().catch(() => undefined);
    return json({ error: "Unauthorized" }, 401);
  }
  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    void request.body?.cancel().catch(() => undefined);
    return json({ error: "Forbidden" }, 403);
  }
  void request.body?.cancel().catch(() => undefined);
  return json({
    kind: "jace_approval_required",
    recordId,
    message: "Ask Jace to create the current correction issue for this Acceptance Record.",
  }, 409);
}
