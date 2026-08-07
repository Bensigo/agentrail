import { NextRequest, NextResponse } from "next/server";
import { claimEvidenceVerificationExecution } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.workerId !== "string" || !body.workerId.trim()) return NextResponse.json({ error: "workerId is required" }, { status: 400 });
  const claimed = await claimEvidenceVerificationExecution({ workerId: body.workerId.trim() });
  if (!claimed) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ workspaceId: claimed.workspaceId, execution: { id: claimed.execution.id, verificationPlanId: claimed.execution.verificationPlanId }, plan: { recordId: claimed.plan.recordId, prRevisionId: claimed.plan.prRevisionId, criterionId: claimed.plan.criterionId, modality: claimed.plan.modality, environmentId: claimed.plan.environmentId, flow: claimed.plan.flow, uiSteps: claimed.plan.uiSteps, apiRequest: claimed.plan.apiRequest, dataRequest: claimed.plan.dataRequest, expectedBehavior: claimed.plan.expectedBehavior }, pr: { repository: claimed.repositoryFullName, number: claimed.prNumber, headSha: claimed.headSha }, previewUrl: claimed.previewUrl });
}
