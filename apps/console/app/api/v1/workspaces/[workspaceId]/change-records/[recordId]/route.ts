import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { parseAcceptanceContract } from "@agentrail/contracts";
import {
  confirmAcceptanceContract,
  createDraftAcceptanceContract,
  getWorkspaceMembership,
  readAcceptanceEvidenceReviewSummaries,
  readAcceptanceContracts,
  readAcceptanceContextPacks,
  readChangeRecordTimeline,
  recordAcceptancePrDecision,
  validateAcceptancePrDecision,
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

function serializeReview(
  review: NonNullable<Awaited<ReturnType<typeof readAcceptanceEvidenceReviewSummaries>>>[number]
) {
  return {
    id: review.id,
    prRevisionId: review.prRevisionId,
    headSha: review.headSha,
    repositoryFullName: review.repositoryFullName,
    prNumber: review.prNumber,
    overallStatus: review.overallStatus,
    contractId: review.contractId,
    contractVersion: review.contractVersion,
    createdAt: review.createdAt.toISOString(),
    supersededAt: review.supersededAt?.toISOString() ?? null,
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

    const [contracts, contextPacks, reviews] = await Promise.all([
      readAcceptanceContracts({ workspaceId, recordId }),
      readAcceptanceContextPacks({ workspaceId, recordId }),
      readAcceptanceEvidenceReviewSummaries({ workspaceId, recordId }),
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
      reviews: (reviews ?? []).map(serializeReview),
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
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === "record_pr_decision") {
    if (membership.role !== "owner" && membership.role !== "admin") {
      return NextResponse.json({ error: "Only workspace owners or admins can record the final PR decision" }, { status: 403 });
    }
    const reviewId = typeof body.reviewId === "string" ? body.reviewId.trim() : "";
    const decisionInput = { decision: body.decision, rationale: body.rationale };
    if (!reviewId || !validateAcceptancePrDecision(decisionInput)) {
      return NextResponse.json({ error: "reviewId, a valid final decision, and an exception rationale when required are required" }, { status: 400 });
    }
    try {
      const result = await recordAcceptancePrDecision({
        workspaceId,
        recordId,
        reviewId,
        decision: decisionInput.decision,
        ...(typeof decisionInput.rationale === "string" ? { rationale: decisionInput.rationale } : {}),
        decidedBy: `user:${session.user.id}`,
      });
      const event = result.event;
      return NextResponse.json({
        inserted: result.inserted,
        event: {
          id: event.id, recordId: event.recordId, eventKey: event.eventKey,
          stage: event.stage, actor: event.actor, payloadRef: event.payloadRef,
          at: event.at.toISOString(), createdAt: event.createdAt.toISOString(),
        },
      }, { status: result.inserted ? 201 : 200 });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to record final PR decision" }, { status: 409 });
    }
  }
  if (body.action === "create_draft_version") {
    const parsedContract = parseAcceptanceContract(body.contract);
    if (!parsedContract.ok) {
      return NextResponse.json({ errors: parsedContract.errors }, { status: 400 });
    }
    const contracts = await readAcceptanceContracts({ workspaceId, recordId });
    if (contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    try {
      const draft = await createDraftAcceptanceContract({
        recordId,
        contract: parsedContract.value,
        createdBy: `user:${session.user.id}`,
      });
      return NextResponse.json({ contract: serializeContract(draft) }, { status: 201 });
    } catch (err) {
      console.error("[change-records] failed to create Acceptance Contract draft:", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to create Acceptance Contract draft" },
        { status: 409 }
      );
    }
  }
  const version = body.version;
  if (body.action !== "confirm_contract" || !Number.isInteger(version) || (version as number) < 1) {
    return NextResponse.json(
      { error: "action must be confirm_contract and version must be a positive integer" },
      { status: 400 }
    );
  }
  if (membership.role !== "owner" && membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only workspace owners or admins can confirm an Acceptance Contract" },
      { status: 403 }
    );
  }
  try {
    const contracts = await readAcceptanceContracts({ workspaceId, recordId });
    if (contracts == null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const contract = await confirmAcceptanceContract({
      workspaceId, recordId,
      version: version as number,
      confirmedBy: `user:${session.user.id}`,
    });
    return NextResponse.json({ contract: serializeContract(contract) });
  } catch (err) {
    console.error("[change-records] failed to confirm Acceptance Contract:", err);
    return NextResponse.json({ error: "Failed to confirm Acceptance Contract" }, { status: 409 });
  }
}
