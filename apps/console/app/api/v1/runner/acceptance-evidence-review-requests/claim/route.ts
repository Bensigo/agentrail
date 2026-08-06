import { NextRequest, NextResponse } from "next/server";
import { claimAcceptanceEvidenceReviewRequest, getInstallationToken } from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../../lib/jace-console-auth";

/**
 * Worker-only claim seam for a blocking-only Acceptance Review. It returns
 * contract and exact PR identity, never a Console-held repository snapshot or
 * a review result. The disposable reviewer must fetch the exact head itself.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId) return NextResponse.json({ error: "workerId is required" }, { status: 400 });

  const claimed = await claimAcceptanceEvidenceReviewRequest({ workerId });
  if (!claimed) return new NextResponse(null, { status: 204 });
  const githubToken = (await getInstallationToken(claimed.request.workspaceId)) ?? "";
  return NextResponse.json({
    request: {
      id: claimed.request.id,
      workspaceId: claimed.request.workspaceId,
      recordId: claimed.request.recordId,
      prRevisionId: claimed.request.prRevisionId,
      acceptanceContractId: claimed.request.acceptanceContractId,
      acceptanceContractVersion: claimed.request.acceptanceContractVersion,
      headSha: claimed.request.headSha,
      attempts: claimed.request.attempts,
    },
    contract: claimed.contract,
    pr: claimed.pr,
    runtimeEvidence: claimed.runtimeEvidence,
    githubToken,
    note: "Claimed is not a review verdict. Fetch and inspect only this exact PR head; completion remains separately validated and may emit only evidence-bound blockers.",
  });
}
