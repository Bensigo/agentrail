import { NextRequest, NextResponse } from "next/server";
import {
  attachDependencyUpgradeApproval,
  createOrGetDependencyUpgradeContract,
  findDependencyCandidate,
  getDependencyUpgradeContract,
  latestTelegramSessionForWorkspace,
  recordDependencyUpgradeContractEvent,
  refreshDependencyUpgradeContractProposal,
  recordApprovalRequest,
} from "@agentrail/db-postgres";
import { requireJaceConsoleSecret } from "../../../../../lib/jace-console-auth";
import {
  buildDependencyUpgradeApprovalInput,
  buildDependencyUpgradeProposal,
  candidateFingerprintMatches,
  dependencyUpgradeApprovalReady,
  type DependencyUpgradeEvidenceInput,
} from "../../../../../lib/dependency-upgrade-contract";
import { renderApprovalMessage } from "../../../../../lib/approval-message";
import {
  buildApprovalKeyboard,
  sendTelegramMessage,
} from "../../workspaces/[workspaceId]/connectors/secret/telegram";

type ProposalRequest = {
  workspaceId: string;
  watchId: string;
  candidateFingerprint: string;
  evidence?: DependencyUpgradeEvidenceInput;
};

function parseBody(value: unknown): ProposalRequest | null {
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
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  const evidence: DependencyUpgradeEvidenceInput | undefined = rawEvidence
    ? {
        releaseEvidence: strings(rawEvidence.releaseEvidence),
        usageScope: strings(rawEvidence.usageScope),
        transitiveCompatibility: typeof rawEvidence.transitiveCompatibility === "string" ? rawEvidence.transitiveCompatibility : undefined,
        security: typeof rawEvidence.security === "string" ? rawEvidence.security : undefined,
        baselineTests: strings(rawEvidence.baselineTests),
        targetTests: strings(rawEvidence.targetTests),
      }
    : undefined;
  return { workspaceId: body.workspaceId, watchId: body.watchId, candidateFingerprint: body.candidateFingerprint, evidence };
}

/**
 * Candidate -> proposal boundary for the heartbeat/Jace coordinator.
 * Observation is read from the tenant-scoped ledger; the request never gets
 * to author package/version/fingerprint fields. A proposal with incomplete
 * evidence is persisted as needs-human-decision and cannot mint an approval.
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

  const proposal = buildDependencyUpgradeProposal(observed.candidate, body.evidence);
  const state = dependencyUpgradeApprovalReady(proposal) ? "proposed" : "needs-human-decision";
  let stored = await createOrGetDependencyUpgradeContract({
    workspaceId: body.workspaceId,
    repositoryId: observed.repositoryId,
    watchId: observed.watchId,
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

  if (!dependencyUpgradeApprovalReady(proposal) || stored.contract.state !== "proposed") {
    return NextResponse.json({ contract: stored.contract, approval: null, needsHumanDecision: proposal.needsHumanDecision }, { status: stored.created ? 202 : 200 });
  }
  if (stored.contract.approvalId) {
    return NextResponse.json({ contract: stored.contract, approval: { id: stored.contract.approvalId }, needsHumanDecision: [] }, { status: 200 });
  }

  const session = await latestTelegramSessionForWorkspace(body.workspaceId);
  if (!session?.eveSessionId) {
    return NextResponse.json({ contract: stored.contract, approval: null, needsHumanDecision: ["no active Jace approval session is available"] }, { status: 202 });
  }

  const toolInput = buildDependencyUpgradeApprovalInput(stored.contract.id, proposal);
  const requestId = `dependency-upgrade:${observed.candidate.fingerprint}`;
  const recorded = await recordApprovalRequest({
    workspaceId: body.workspaceId,
    chatIdentityId: session.chatIdentityId ?? undefined,
    sessionId: session.id,
    eveSessionId: session.eveSessionId,
    requestId,
    // This is the same create_issue approval type used by Jace. The reserved
    // dependencyContractId makes the decision side effect publish this exact
    // candidate rather than invoking an unbound generic write.
    toolName: "dependency_upgrade_contract",
    toolInput,
    approveOptionId: "approve",
    denyOptionId: "deny",
    dependencyContractId: stored.contract.id,
  });
  const attached = await attachDependencyUpgradeApproval(body.workspaceId, stored.contract.id, recorded.approval.id);
  if (!attached || attached.approvalId !== recorded.approval.id) {
    return NextResponse.json({ error: "Dependency upgrade approval could not be bound to its contract" }, { status: 409 });
  }
  if (recorded.created) {
    await recordDependencyUpgradeContractEvent({
      workspaceId: body.workspaceId,
      contractId: stored.contract.id,
      candidateFingerprint: observed.candidate.fingerprint,
      actor: { actorType: "system", actorId: "jace" },
      decision: "approval_requested",
      approvalId: recorded.approval.id,
    });
  }

  if (recorded.created && session.channel === "telegram" && process.env.TELEGRAM_BOT_TOKEN) {
    const text = renderApprovalMessage("alignment_brief", (toolInput._brief ?? toolInput) as Record<string, unknown>);
    await sendTelegramMessage(
      process.env.TELEGRAM_BOT_TOKEN,
      session.conversationKey,
      text,
      buildApprovalKeyboard(recorded.approval.callbackToken)
    ).catch((error: unknown) => console.error("[dependency-upgrade-proposals] approval notification failed:", error));
  }

  const contract = await getDependencyUpgradeContract(body.workspaceId, stored.contract.id);
  return NextResponse.json({ contract, approval: { id: recorded.approval.id, status: recorded.approval.status }, needsHumanDecision: [] }, { status: stored.created ? 201 : 200 });
}
