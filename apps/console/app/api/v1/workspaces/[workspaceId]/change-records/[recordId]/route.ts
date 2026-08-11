import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  readCurrentAcceptanceCorrectionPackets,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId, recordId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const timeline = await readChangeRecordTimeline({ workspaceId, recordId });
    if (!timeline) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const resolvedCorrectionPackets = await readCurrentAcceptanceCorrectionPackets({
      workspaceId,
      recordId,
    });
    const correctionPackets = resolvedCorrectionPackets.kind === "current" && (
      !timeline.record.currentPrHeadAuthoritative
      || timeline.record.workspaceId !== resolvedCorrectionPackets.binding.workspaceId
      || timeline.record.id !== resolvedCorrectionPackets.binding.recordId
      || timeline.record.repo !== resolvedCorrectionPackets.binding.repo
      || timeline.record.prNumber !== resolvedCorrectionPackets.binding.prNumber
      || timeline.record.currentPrHeadSha !== resolvedCorrectionPackets.binding.headSha
      || timeline.record.currentPrHeadCycleId !== resolvedCorrectionPackets.binding.headCycleId
      || timeline.record.currentPrHeadAuthorityGeneration
        !== resolvedCorrectionPackets.binding.authorityGeneration
    )
      ? { kind: "not_current" as const }
      : resolvedCorrectionPackets;

    return NextResponse.json({
      record: {
        id: timeline.record.id,
        workspaceId: timeline.record.workspaceId,
        repo: timeline.record.repo,
        issueNumber: timeline.record.issueNumber,
        prNumber: timeline.record.prNumber,
        headShas: timeline.record.headShas,
        currentPrHeadSha: timeline.record.currentPrHeadSha,
        currentPrHeadCycleId: timeline.record.currentPrHeadCycleId,
        currentPrHeadAuthoritative: timeline.record.currentPrHeadAuthoritative,
        mergedSha: timeline.record.mergedSha,
        state: timeline.record.state,
        createdAt: timeline.record.createdAt.toISOString(),
        updatedAt: timeline.record.updatedAt.toISOString(),
      },
      events: timeline.events.map((event) => ({
        id: event.id,
        recordId: event.recordId,
        eventKey: event.eventKey,
        stage: event.stage,
        actor: event.actor,
        payloadRef: event.payloadRef,
        at: event.at.toISOString(),
        createdAt: event.createdAt.toISOString(),
      })),
      correctionPackets,
    });
  } catch (err) {
    console.error("[change-records] failed to load detail:", err);
    return NextResponse.json(
      { error: "Failed to load change record detail" },
      { status: 500 }
    );
  }
}
