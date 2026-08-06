import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import { parseAcceptanceContract } from "@agentrail/contracts";
import {
  confirmAcceptanceContract,
  createDraftAcceptanceContract,
  getWorkspaceMembership,
  readAcceptanceEvidenceReviewSummaries,
  readAcceptanceEvidenceReviewRequests,
  readAcceptanceContracts,
  readAcceptanceContextPackCompilations,
  readAcceptanceContextPacks,
  readAcceptanceBuilderHandoffs,
  readEvidenceReviewCorrectionDeliveriesForRecord,
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

function serializeContextPackCompilation(
  compilation: NonNullable<Awaited<ReturnType<typeof readAcceptanceContextPackCompilations>>>[number]
) {
  return {
    id: compilation.id,
    acceptanceContractId: compilation.acceptanceContractId,
    acceptanceContractVersion: compilation.acceptanceContractVersion,
    repositoryId: compilation.repositoryId,
    repositoryRef: compilation.repositoryRef,
    phase: compilation.phase,
    status: compilation.status,
    contextPackId: compilation.contextPackId,
    reason: compilation.reason,
    createdAt: compilation.createdAt.toISOString(),
    updatedAt: compilation.updatedAt.toISOString(),
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

function serializeReviewRequest(
  request: Awaited<ReturnType<typeof readAcceptanceEvidenceReviewRequests>>[number]
) {
  return {
    id: request.id,
    prRevisionId: request.prRevisionId,
    acceptanceContractId: request.acceptanceContractId,
    acceptanceContractVersion: request.acceptanceContractVersion,
    headSha: request.headSha,
    status: request.status,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

function serializeBuilderHandoff(
  handoff: NonNullable<Awaited<ReturnType<typeof readAcceptanceBuilderHandoffs>>>[number]
) {
  return {
    id: handoff.id,
    builder: handoff.builder,
    taskContextKey: handoff.taskContextKey,
    branchName: handoff.branchName,
    acceptanceContractId: handoff.acceptanceContractId,
    acceptanceContractVersion: handoff.acceptanceContractVersion,
    contextPackId: handoff.contextPackId,
    status: handoff.status,
    createdAt: handoff.createdAt.toISOString(),
    prAttachedAt: handoff.prAttachedAt?.toISOString() ?? null,
  };
}

function serializeCorrectionDelivery(
  row: Awaited<ReturnType<typeof readEvidenceReviewCorrectionDeliveriesForRecord>>[number]
) {
  return {
    id: row.delivery.id,
    channel: row.delivery.channel,
    target: row.delivery.target,
    reviewRevisionId: row.delivery.reviewRevisionId,
    headSha: row.revision.headSha,
    prNumber: row.pr.prNumber,
    attempt: row.delivery.attempt,
    outcome: row.delivery.outcome,
    outcomeDetail: row.delivery.outcomeDetail,
    queuedAt: row.delivery.queuedAt.toISOString(),
    attemptedAt: row.delivery.attemptedAt?.toISOString() ?? null,
    confirmedAt: row.delivery.confirmedAt?.toISOString() ?? null,
    correction: {
      id: row.correction.id,
      criterionId: row.correction.criterionId,
      observedBehavior: row.correction.observedBehavior,
      expectedBehavior: row.correction.expectedBehavior,
      evidenceRefs: row.correction.evidenceRefs,
      likelyAffectedUnits: row.correction.likelyAffectedUnits,
      contextRefs: row.correction.contextRefs,
      scopeBoundary: row.correction.scopeBoundary,
      concreteImpact: row.correction.concreteImpact,
      requiredCorrection: row.correction.requiredCorrection,
      reverification: row.correction.reverification,
      repairPath: row.correction.repairPath,
    },
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

    const [contracts, contextPacks, contextPackCompilations, reviews, reviewRequests, handoffs, correctionDeliveries] = await Promise.all([
      readAcceptanceContracts({ workspaceId, recordId }),
      readAcceptanceContextPacks({ workspaceId, recordId }),
      readAcceptanceContextPackCompilations({ workspaceId, recordId }),
      readAcceptanceEvidenceReviewSummaries({ workspaceId, recordId }),
      readAcceptanceEvidenceReviewRequests({ workspaceId, recordId }),
      readAcceptanceBuilderHandoffs({ workspaceId, recordId }),
      readEvidenceReviewCorrectionDeliveriesForRecord({ workspaceId, recordId }),
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
      contextPackCompilations: (contextPackCompilations ?? []).map(serializeContextPackCompilation),
      reviews: (reviews ?? []).map(serializeReview),
      reviewRequests: reviewRequests.map(serializeReviewRequest),
      handoffs: (handoffs ?? []).map(serializeBuilderHandoff),
      correctionDeliveries: correctionDeliveries.map(serializeCorrectionDelivery),
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
