import { NextRequest, NextResponse } from "next/server";
import { readEvidenceReviewCorrectionDeliveriesForTask } from "@agentrail/db-postgres";
import { requireAgentMcpWorkspace } from "@/lib/agent-mcp-auth";

const nonempty = (value: string | null): value is string => Boolean(value?.trim());

/**
 * Durable, task-context-scoped correction inbox. Retrieval makes a packet
 * available to a supported builder integration; only the separate ack route
 * records confirmed receipt.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const authorization = await requireAgentMcpWorkspace(request, workspaceId, "acceptance:read");
  if (authorization instanceof NextResponse) return authorization;
  const builder = request.nextUrl.searchParams.get("builder")?.trim() ?? "";
  const taskContextKey = request.nextUrl.searchParams.get("taskContextKey")?.trim() ?? "";
  if (!nonempty(builder) || !nonempty(taskContextKey)) {
    return NextResponse.json({ error: "builder and taskContextKey are required" }, { status: 400 });
  }
  const rows = await readEvidenceReviewCorrectionDeliveriesForTask({ workspaceId, builder, taskContextKey });
  return NextResponse.json({
    deliveries: rows.map(({ delivery, correction, review, revision, pr }) => ({
      delivery: {
        id: delivery.id, channel: delivery.channel, target: delivery.target,
        attempt: delivery.attempt, outcome: delivery.outcome, outcomeDetail: delivery.outcomeDetail,
        attemptedAt: delivery.attemptedAt.toISOString(),
        confirmedAt: delivery.confirmedAt?.toISOString() ?? null,
      },
      reviewRevision: {
        id: revision.id, repository: pr.repositoryFullName, prNumber: pr.prNumber,
        headSha: revision.headSha, reviewId: review.id,
      },
      packet: {
        correctionId: correction.id, criterionId: correction.criterionId,
        expectedBehavior: correction.expectedBehavior, observedBehavior: correction.observedBehavior,
        evidenceRefs: correction.evidenceRefs, reproductionSteps: correction.reproductionSteps,
        relevantLocations: correction.likelyAffectedUnits, contextRefs: correction.contextRefs,
        ruleOrBoundary: correction.scopeBoundary, concreteImpact: correction.concreteImpact,
        requiredCorrection: correction.requiredCorrection, reverification: correction.reverification,
        repairPath: correction.repairPath,
      },
    })),
  });
}
