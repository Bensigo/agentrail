import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  recordAcceptancePostMergeOutcome,
  validateAcceptancePostMergeOutcome,
} from "@agentrail/db-postgres";

/**
 * Records human-authorized post-merge provenance only. This endpoint cannot
 * merge, deploy, alter an external builder, or replace the evidence verdict.
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

  const body = await request.json().catch(() => null);
  const outcome = body != null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).outcome
    : null;
  if (!validateAcceptancePostMergeOutcome(outcome)) {
    return NextResponse.json({ error: "Invalid post-merge outcome" }, { status: 400 });
  }

  try {
    const recorded = await recordAcceptancePostMergeOutcome({
      workspaceId,
      recordId,
      recordedBy: `user:${session.user.id}`,
      outcome,
    });
    return NextResponse.json({
      inserted: recorded.inserted,
      event: {
        id: recorded.event.id,
        eventKey: recorded.event.eventKey,
        stage: recorded.event.stage,
        at: recorded.event.at.toISOString(),
        payloadRef: recorded.event.payloadRef,
      },
    }, { status: recorded.inserted ? 201 : 200 });
  } catch (error) {
    console.error("[change-record-post-merge-outcomes] failed to record outcome:", error);
    return NextResponse.json({ error: "Post-merge outcome conflicts with this Acceptance Record" }, { status: 409 });
  }
}
