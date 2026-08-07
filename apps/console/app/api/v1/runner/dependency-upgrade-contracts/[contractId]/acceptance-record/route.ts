import { NextRequest, NextResponse } from "next/server";
import { createDraftAcceptanceRecord, getDependencyUpgradeContract, getRepository } from "@agentrail/db-postgres";
import { dependencyProposalFromUnknown, dependencyProposalToAcceptanceContract } from "../../../../../../../lib/dependency-upgrade-acceptance";
import { requireJaceConsoleSecret } from "../../../../../../../lib/jace-console-auth";

/**
 * Materialize a dependency candidate as a normal Jace Acceptance Record. This
 * does not carry forward the legacy approval-to-issue side effect.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ contractId: string }> }) {
  const unauthorized = requireJaceConsoleSecret(request);
  if (unauthorized) return unauthorized;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const { contractId } = await params;
  if (!workspaceId || !contractId) return NextResponse.json({ error: "workspaceId and dependency contract are required" }, { status: 400 });
  const source = await getDependencyUpgradeContract(workspaceId, contractId);
  if (!source) return NextResponse.json({ error: "Dependency upgrade contract not found" }, { status: 404 });
  const proposal = dependencyProposalFromUnknown(source.proposal);
  if (!proposal) return NextResponse.json({ error: "Dependency upgrade proposal is not a valid Acceptance Contract source" }, { status: 409 });
  const repository = await getRepository(workspaceId, source.repositoryId);
  if (!repository) return NextResponse.json({ error: "Connected repository not found" }, { status: 409 });
  try {
    const draft = await createDraftAcceptanceRecord({
      workspaceId,
      repo: repository.name,
      originChannel: "dependency_watch",
      workKey: `dependency-upgrade:${source.id}`,
      sourceReferences: [{
        kind: "dependency_upgrade_candidate", contractId: source.id,
        candidateFingerprint: source.candidateFingerprint, observationKey: source.observationKey,
        baselineSha: source.baselineSha,
      }],
      contract: dependencyProposalToAcceptanceContract(proposal),
      createdBy: "jace:dependency-watch",
    });
    return NextResponse.json({
      record: { id: draft.record.id, repo: draft.record.repo },
      contract: { id: draft.contract.id, version: draft.contract.version, status: draft.contract.status },
      source: { dependencyUpgradeContractId: source.id, candidateFingerprint: source.candidateFingerprint },
    }, { status: 201 });
  } catch (error) {
    console.error("[runner/dependency-upgrade-acceptance] failed:", error);
    return NextResponse.json({ error: "Failed to create dependency Acceptance Record" }, { status: 502 });
  }
}
