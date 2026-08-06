import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  confirmAcceptanceContract,
  getWorkspaceMembership,
  readAcceptanceContracts,
  readAcceptanceContextPacks,
  readChangeRecordTimeline,
} from "@agentrail/db-postgres";

function serializeContract(contract: Awaited<ReturnType<typeof confirmAcceptanceContract>>) {
  return {
    id: contract.id,
    recordId: contract.recordId,
    version: contract.version,
    status: contract.status,
    contract: contract.contract,
    createdBy: contract.createdBy,
    confirmedBy: contract.confirmedBy,
    confirmedAt: contract.confirmedAt?.toISOString() ?? null,
    createdAt: contract.createdAt.toISOString(),
  };
}

function serializeContextPack(
  pack: NonNullable<Awaited<ReturnType<typeof readAcceptanceContextPacks>>>[number]
) {
  return {
    id: pack.id,
    recordId: pack.recordId,
    version: pack.version,
    phase: pack.phase,
    contentHash: pack.contentHash,
    compilerVersion: pack.compilerVersion,
    manifest: pack.manifest,
    custody: pack.custody,
    freshness: pack.freshness,
    jsonArtifactRef: pack.jsonArtifactRef,
    markdownArtifactRef: pack.markdownArtifactRef,
    createdBy: pack.createdBy,
    createdAt: pack.createdAt.toISOString(),
  };
}

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

    const [contracts, contextPacks] = await Promise.all([
      readAcceptanceContracts({ workspaceId, recordId }),
      readAcceptanceContextPacks({ workspaceId, recordId }),
    ]);
    return NextResponse.json({
      record: {
        id: timeline.record.id,
        workspaceId: timeline.record.workspaceId,
        repo: timeline.record.repo,
        issueNumber: timeline.record.issueNumber,
        prNumber: timeline.record.prNumber,
        headShas: timeline.record.headShas,
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
      contracts: (contracts ?? []).map(serializeContract),
      contextPacks: (contextPacks ?? []).map(serializeContextPack),
    });
  } catch (err) {
    console.error("[change-records] failed to load timeline:", err);
    return NextResponse.json(
      { error: "Failed to load change record timeline" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; recordId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { workspaceId, recordId } = await params;
  if (!(await getWorkspaceMembership(session.user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const version = body.version;
  if (body.action !== "confirm_contract" || !Number.isInteger(version) || (version as number) < 1) {
    return NextResponse.json(
      { error: "action must be confirm_contract and version must be a positive integer" },
      { status: 400 }
    );
  }
  try {
    const contracts = await readAcceptanceContracts({ workspaceId, recordId });
    if (contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const contract = await confirmAcceptanceContract({
      recordId,
      version: version as number,
      confirmedBy: `user:${session.user.id}`,
    });
    return NextResponse.json({ contract: serializeContract(contract) });
  } catch (err) {
    console.error("[change-records] failed to confirm Acceptance Contract:", err);
    return NextResponse.json({ error: "Failed to confirm Acceptance Contract" }, { status: 409 });
  }
}
