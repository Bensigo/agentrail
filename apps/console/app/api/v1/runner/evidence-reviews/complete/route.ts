import { NextRequest, NextResponse } from "next/server";
import { parseAcceptanceContract } from "@agentrail/contracts";
import { findAcceptanceBuilderHandoffForPrRevision, queueEvidenceReviewCorrectionDelivery, readClaimedAcceptanceEvidenceReviewRequest, recordEvidenceReview } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";
import { buildCorrectionPacket, validateEvidenceReview } from "../../../../../../lib/evidence-review-validation";

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function object(value: unknown): value is Record<string, unknown> { return value != null && typeof value === "object" && !Array.isArray(value); }

/** Independent verifier completion only; it cannot create an advisory review. */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const body: Record<string, unknown> = await request.json().catch(() => ({}));
  const requiredText = ["workspaceId", "recordId", "prRevisionId", "headSha", "contractId", "reviewRequestId", "workerId", "verifierName", "verifierVersion", "promptVersion", "environmentRung"];
  if (!object(body) || requiredText.some((key) => !text(body[key])) || !Number.isInteger(body.contractVersion) || !Array.isArray(body.criteria) || !Array.isArray(body.findings) || !Array.isArray(body.testResults) || !Array.isArray(body.staticFindings) || !object(body.diffIdentity) || !object(body.independentVerifier) || !object(body.reviewabilityResult)) {
    return NextResponse.json({ error: "invalid evidence review completion payload" }, { status: 400 });
  }
  const claim = await readClaimedAcceptanceEvidenceReviewRequest({ reviewRequestId: body.reviewRequestId as string, workerId: body.workerId as string });
  if (!claim || claim.request.workspaceId !== body.workspaceId || claim.request.recordId !== body.recordId || claim.request.prRevisionId !== body.prRevisionId || claim.request.headSha !== body.headSha || claim.contract.id !== body.contractId || claim.contract.version !== body.contractVersion) {
    return NextResponse.json({ error: "current worker-owned exact-head review request not found" }, { status: 409 });
  }
  const contractRow = claim.contract;
  const parsed = parseAcceptanceContract(contractRow.contract);
  if (!parsed.ok) return NextResponse.json({ error: "stored Acceptance Contract is invalid" }, { status: 500 });
  const validation = validateEvidenceReview({
    contract: parsed.value, headSha: body.headSha,
    criteria: body.criteria as never, findings: body.findings as never,
  });
  if (!validation.ok) return NextResponse.json({ error: "invalid evidence review", errors: validation.errors }, { status: 400 });
  const criteria = body.criteria as Parameters<typeof validateEvidenceReview>[0]["criteria"];
  const findings = body.findings as Parameters<typeof validateEvidenceReview>[0]["findings"];
  const corrections = criteria.filter((criterion) => criterion.status === "failed").map((criterion) => {
    const finding = findings.find((item) => item.criterionId === criterion.criterionId);
    return finding ? buildCorrectionPacket({ headSha: body.headSha as string, criterion, finding }) : null;
  }).filter((item): item is NonNullable<typeof item> => item != null);
  try {
    const handoff = await findAcceptanceBuilderHandoffForPrRevision({
      workspaceId: body.workspaceId as string,
      recordId: body.recordId as string,
      prRevisionId: body.prRevisionId as string,
    });
    const result = await recordEvidenceReview({
      workspaceId: body.workspaceId as string, recordId: body.recordId as string, prRevisionId: body.prRevisionId as string, headSha: body.headSha as string, reviewRequestId: body.reviewRequestId as string, workerId: body.workerId as string,
      contractId: body.contractId as string, contractVersion: body.contractVersion as number, overallStatus: validation.overallStatus,
      diffIdentity: body.diffIdentity, staticFindings: body.staticFindings as Record<string, unknown>[], testResults: body.testResults as Record<string, unknown>[],
      independentVerifier: body.independentVerifier, reviewabilityResult: body.reviewabilityResult, environmentRung: body.environmentRung as string,
      refusalReason: text(body.refusalReason) ? body.refusalReason : null, verifierName: body.verifierName as string,
      verifierVersion: body.verifierVersion as string, promptVersion: body.promptVersion as string,
      criteria: criteria.map((criterion) => ({ ...criterion, criterionTextSnapshot: parsed.value.acceptanceCriteria.find((item) => item.id === criterion.criterionId)!.text, required: parsed.value.acceptanceCriteria.find((item) => item.id === criterion.criterionId)!.required, runtimeEvidence: criterion.runtimeEvidence ?? [] })),
      corrections: corrections.map((packet) => ({
        criterionId: packet.criterionId, observedBehavior: packet.observedBehavior,
        expectedBehavior: packet.expectedBehavior, evidenceRefs: packet.evidenceRefs,
        likelyAffectedUnits: packet.relevantLocations.map((location) => `${location.path}:${location.startLine}-${location.endLine}`),
        contextRefs: [], scopeBoundary: packet.ruleOrBoundary,
        concreteImpact: packet.concreteImpact, requiredCorrection: packet.requiredCorrection,
        reverification: packet.reverification, repairPath: packet.repairPath ?? null,
      })),
    });
    const correctionDeliveries = handoff ? await Promise.all(result.corrections.map(async (correction) => {
      const delivery = await queueEvidenceReviewCorrectionDelivery({
        workspaceId: body.workspaceId as string,
        recordId: body.recordId as string,
        correctionId: correction.id,
        deliveryKey: `mcp:${handoff.id}:${correction.id}`,
        channel: "mcp_task_context",
        target: { builder: handoff.builder, taskContextKey: handoff.taskContextKey },
      });
      return { id: delivery.id, correctionId: correction.id, outcome: "queued" };
    })) : [];
    return NextResponse.json({ reviewId: result.id, inserted: result.inserted, overallStatus: validation.overallStatus, correctionPackets: corrections, correctionDeliveries, deliveryTargetResolved: Boolean(handoff) }, { status: result.inserted ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to persist evidence review" }, { status: 409 });
  }
}
