import { NextRequest, NextResponse } from "next/server";
import {
  createDraftAcceptanceRecord,
  createOrGetDependencyUpgradeContract,
  findDependencyCandidate,
  getRepository,
  refreshDependencyUpgradeContractProposal,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import {
  buildDependencyUpgradeProposal,
  candidateFingerprintMatches,
  dependencyUpgradeApprovalReady,
  type DependencyUpgradeEvidenceInput,
} from "../../../../../lib/dependency-upgrade-contract";
import {
  dependencyProposalFromUnknown,
  dependencyProposalToAcceptanceContract,
} from "../../../../../lib/dependency-upgrade-acceptance";

type ProposalRequest = {
  workspaceId: string;
  watchId: string;
  candidateFingerprint: string;
  evidence?: DependencyUpgradeEvidenceInput;
};

type ParsedProposalRequest = ProposalRequest & {
  evidenceIssues: string[];
};

function parseEvidenceList(
  field: "releaseEvidence" | "usageScope" | "baselineTests" | "targetTests",
  value: unknown
): { values?: string[]; issues: string[] } {
  if (value === undefined) return { values: undefined, issues: [] };
  if (!Array.isArray(value)) return { issues: [`${field} is not a supported evidence list`] };
  const values: string[] = [];
  const issues: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      values.push(item);
    } else {
      issues.push(`${field} contains unsupported evidence`);
    }
  }
  return { values: values.length ? values : undefined, issues };
}

function parseBody(value: unknown): ParsedProposalRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.workspaceId !== "string" ||
    typeof body.watchId !== "string" ||
    typeof body.candidateFingerprint !== "string" ||
    !body.workspaceId.trim() ||
    !body.watchId.trim() ||
    !body.candidateFingerprint.trim()
  ) return null;
  const rawEvidence = body.evidence && typeof body.evidence === "object" && !Array.isArray(body.evidence)
    ? body.evidence as Record<string, unknown>
    : undefined;
  if (typeof body.evidence !== "undefined" && !rawEvidence) {
    return {
      workspaceId: body.workspaceId,
      watchId: body.watchId,
      candidateFingerprint: body.candidateFingerprint,
      evidence: undefined,
      evidenceIssues: ["evidence payload is not a supported evidence object"],
    };
  }
  const releaseEvidence = parseEvidenceList("releaseEvidence", rawEvidence?.releaseEvidence);
  const usageScope = parseEvidenceList("usageScope", rawEvidence?.usageScope);
  const baselineTests = parseEvidenceList("baselineTests", rawEvidence?.baselineTests);
  const targetTests = parseEvidenceList("targetTests", rawEvidence?.targetTests);
  const evidenceIssues = [
    ...releaseEvidence.issues,
    ...usageScope.issues,
    ...baselineTests.issues,
    ...targetTests.issues,
  ];
  const evidence: DependencyUpgradeEvidenceInput | undefined = rawEvidence
    ? {
        releaseEvidence: releaseEvidence.values,
        usageScope: usageScope.values,
        transitiveCompatibility: typeof rawEvidence.transitiveCompatibility === "string" ? rawEvidence.transitiveCompatibility : undefined,
        security: typeof rawEvidence.security === "string" ? rawEvidence.security : undefined,
        baselineTests: baselineTests.values,
        targetTests: targetTests.values,
      }
    : undefined;
  if (rawEvidence && typeof rawEvidence.transitiveCompatibility !== "undefined" && typeof rawEvidence.transitiveCompatibility !== "string") {
    evidenceIssues.push("transitiveCompatibility is not a supported evidence value");
  }
  if (rawEvidence && typeof rawEvidence.security !== "undefined" && typeof rawEvidence.security !== "string") {
    evidenceIssues.push("security is not a supported evidence value");
  }
  return { workspaceId: body.workspaceId, watchId: body.watchId, candidateFingerprint: body.candidateFingerprint, evidence, evidenceIssues };
}

/**
 * Candidate -> proposal boundary for the heartbeat/Jace coordinator.
 * Observation is read from the tenant-scoped ledger; the request never gets
 * to author package/version/fingerprint fields. The result is a canonical
 * draft Acceptance Record. It never creates an approval, issue, dependency
 * edit, builder handoff, PR, or merge.
 */
export async function POST(request: NextRequest) {
  const authError = requireJaceConsoleSecret(request);
  if (authError) return authError;
  const raw = await request.json().catch(() => null);
  const body = parseBody(raw);
  if (!body) return NextResponse.json({ error: "workspaceId, watchId, and candidateFingerprint are required" }, { status: 400 });

  const observed = await findDependencyCandidate({
    workspaceId: body.workspaceId,
    watchId: body.watchId,
    fingerprint: body.candidateFingerprint,
  });
  if (!observed) return NextResponse.json({ error: "Candidate not found or fingerprint is stale" }, { status: 409 });
  if (!candidateFingerprintMatches(observed.candidate)) {
    return NextResponse.json({ error: "Candidate fingerprint is invalid" }, { status: 409 });
  }

  const proposal = buildDependencyUpgradeProposal(observed.candidate, body.evidence, {
    observationKey: observed.observationKey,
    evidenceIssues: body.evidenceIssues,
  });
  const state = dependencyUpgradeApprovalReady(proposal) ? "proposed" : "needs-human-decision";
  let stored = await createOrGetDependencyUpgradeContract({
    workspaceId: body.workspaceId,
    repositoryId: observed.repositoryId,
    watchId: observed.watchId,
    observationKey: observed.observationKey,
    candidate: observed.candidate,
    proposal: proposal as unknown as Record<string, unknown>,
    state,
    createdBy: "dependency-watch",
  });

  if (
    dependencyUpgradeApprovalReady(proposal) &&
    stored.contract.state === "needs-human-decision" &&
    !stored.contract.approvalId
  ) {
    const refreshed = await refreshDependencyUpgradeContractProposal({
      workspaceId: body.workspaceId,
      contractId: stored.contract.id,
      proposal: proposal as unknown as Record<string, unknown>,
    });
    if (refreshed) stored = { contract: refreshed, created: false };
  }

  const sourceProposal = dependencyProposalFromUnknown(stored.contract.proposal);
  if (!sourceProposal) {
    return NextResponse.json({ error: "Dependency upgrade proposal is not a valid Acceptance Contract source" }, { status: 409 });
  }
  const repository = await getRepository(body.workspaceId, stored.contract.repositoryId);
  if (!repository) return NextResponse.json({ error: "Connected repository not found" }, { status: 409 });

  try {
    const draft = await createDraftAcceptanceRecord({
      workspaceId: body.workspaceId,
      repo: repository.name,
      originChannel: "dependency_watch",
      workKey: `dependency-upgrade:${stored.contract.id}`,
      sourceReferences: [{
        kind: "dependency_upgrade_candidate",
        contractId: stored.contract.id,
        candidateFingerprint: stored.contract.candidateFingerprint,
        observationKey: stored.contract.observationKey,
        baselineSha: stored.contract.baselineSha,
      }],
      contract: dependencyProposalToAcceptanceContract(sourceProposal),
      createdBy: "jace:dependency-watch",
    });
    return NextResponse.json({
      record: { id: draft.record.id, repo: draft.record.repo },
      contract: { id: draft.contract.id, version: draft.contract.version, status: draft.contract.status },
      source: {
        dependencyUpgradeContractId: stored.contract.id,
        candidateFingerprint: stored.contract.candidateFingerprint,
      },
      needsHumanDecision: sourceProposal.needsHumanDecision,
    }, { status: 201 });
  } catch (error) {
    console.error("[runner/dependency-upgrade-proposals] failed to create Acceptance Record:", error);
    return NextResponse.json({ error: "Failed to create dependency Acceptance Record" }, { status: 502 });
  }
}
