import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  recordAcceptanceBuilderRouteSelection,
} from "@agentrail/db-postgres";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseRouteIdBody(requestBody: unknown): string | null {
  if (requestBody === null || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    return null;
  }

  const entries = Object.entries(requestBody as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== "routeId") {
    return null;
  }

  const routeId = entries[0][1];
  return typeof routeId === "string" && UUID_RE.test(routeId) ? routeId : null;
}

/**
 * Records the one authorized builder route for an Acceptance Record. The
 * client supplies only an opaque route ID; storage resolves its server-owned
 * adapter, capability, and configuration version. This endpoint cannot
 * dispatch a vendor, resume a task, select a model, or make a network call.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const routeId = parseRouteIdBody(await request.json().catch(() => null));
  if (!routeId) {
    return NextResponse.json({ error: "Invalid builder route ID" }, { status: 400 });
  }

  try {
    const recorded = await recordAcceptanceBuilderRouteSelection({
      workspaceId,
      recordId,
      selectedBy: `user:${session.user.id}`,
      routeId,
    });
    return NextResponse.json(
      {
        inserted: recorded.inserted,
        event: {
          id: recorded.event.id,
          eventKey: recorded.event.eventKey,
          stage: recorded.event.stage,
          at: recorded.event.at.toISOString(),
          payloadRef: recorded.event.payloadRef,
        },
      },
      { status: recorded.inserted ? 201 : 200 }
    );
  } catch (error) {
    console.error("[change-record-builder-route] failed to record route:", error);
    return NextResponse.json(
      { error: "Builder route selection conflicts with this Acceptance Record" },
      { status: 409 }
    );
  }
}
