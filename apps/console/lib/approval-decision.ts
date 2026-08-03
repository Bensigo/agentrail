import {
  confirmAlignmentBrief,
  decideDependencyUpgradeContract,
  denyAlignmentBrief,
  getDependencyUpgradeContractById,
  recordDependencyUpgradeContractEvent,
  setDependencyUpgradeContractState,
  enqueueGithubIssue,
  stampPublishedIssueUrl,
  type JaceApprovalRow,
} from "@agentrail/db-postgres";
import { extractConfirmedBudgetAndModel } from "./alignment-brief";
import { publishDependencyUpgradeIssue } from "./dependency-upgrade-publisher";

export type ApprovalActor = {
  actorType: string;
  actorId: string;
};

function actorForApproval(approval: JaceApprovalRow, actor?: ApprovalActor): ApprovalActor {
  return (
    actor ??
    (approval.chatIdentityId
      ? { actorType: "chat_identity", actorId: approval.chatIdentityId }
      : { actorType: "approval", actorId: approval.id })
  );
}

async function applyDependencyUpgradeContractDecision(
  approval: JaceApprovalRow,
  decision: "approved" | "denied",
  actor?: ApprovalActor
): Promise<void> {
  const rawContractId = approval.dependencyContractId;
  const payloadContractId = approval.toolInput["contractId"];
  if (
    typeof rawContractId !== "string" ||
    !rawContractId ||
    (payloadContractId !== undefined && payloadContractId !== rawContractId)
  ) {
    console.error(`[approval-decision] dependency contract approval ${approval.id} has no matching persisted contract binding`);
    return;
  }
  let contract = await getDependencyUpgradeContractById(rawContractId);
  if (!contract || contract.workspaceId !== approval.workspaceId) {
    console.error(`[approval-decision] dependency contract ${rawContractId} is missing or cross-workspace`);
    return;
  }
  const resolvedActor = actorForApproval(approval, actor);

  const resolved = await decideDependencyUpgradeContract({
    workspaceId: contract.workspaceId,
    contractId: contract.id,
    approvalId: approval.id,
    decision,
    actor: resolvedActor,
  });
  if (decision === "denied" || resolved.status !== "approved" || !resolved.contract) return;
  contract = resolved.contract;

  const candidate = {
    package: contract.packageName,
    dependency_kind: contract.dependencyKind,
    specifier: contract.specifier,
    current_version: contract.currentVersion,
    target_version: contract.targetVersion,
    manifest_path: contract.manifestPath,
    lockfile_path: contract.lockfilePath,
    baseline_sha: contract.baselineSha,
    fingerprint: contract.candidateFingerprint,
  };
  try {
    const published = await publishDependencyUpgradeIssue({
      workspaceId: contract.workspaceId,
      repositoryId: contract.repositoryId,
      approvalId: approval.id,
      contractId: contract.id,
      candidate,
      proposal: contract.proposal as Parameters<typeof publishDependencyUpgradeIssue>[0]["proposal"],
    });
    const stamped = await stampPublishedIssueUrl(approval.id, published.url);
    if (stamped === "conflict" || stamped === "not_approved") {
      throw new Error(`approval URL stamp failed: ${stamped}`);
    }
    await enqueueGithubIssue({
      workspaceId: contract.workspaceId,
      repoFullName: published.repoFullName,
      number: published.number,
      title: (contract.proposal as Record<string, unknown>).title as string,
      body: published.body,
    });
    await setDependencyUpgradeContractState({
      workspaceId: contract.workspaceId,
      contractId: contract.id,
      state: "published",
      issueUrl: published.url,
      issueNumber: published.number,
      lastError: null,
    });
    await recordDependencyUpgradeContractEvent({
      workspaceId: contract.workspaceId,
      contractId: contract.id,
      candidateFingerprint: contract.candidateFingerprint,
      actor: resolvedActor,
      decision: "published",
      approvalId: approval.id,
      details: { issueUrl: published.url, issueNumber: published.number },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "GitHub issue publication failed";
    await setDependencyUpgradeContractState({
      workspaceId: contract.workspaceId,
      contractId: contract.id,
      state: "needs-human-decision",
      lastError: reason,
    });
    await recordDependencyUpgradeContractEvent({
      workspaceId: contract.workspaceId,
      contractId: contract.id,
      candidateFingerprint: contract.candidateFingerprint,
      actor: resolvedActor,
      decision: "failed",
      approvalId: approval.id,
      details: { reason },
    });
    console.error(`[approval-decision] dependency contract ${contract.id} publication failed:`, error);
  }
}

/**
 * The #1274 alignment-gate confirm/deny side-effect (#1276 PR ②: promoted out
 * of the Telegram webhook route into this shared lib — pure move, no behavior
 * change — so the console's own Approve/Deny actions resolve through the
 * EXACT SAME seam a Telegram tap does, rather than growing a second,
 * drifting copy of this ~35-line function. Both
 * `app/api/v1/connectors/telegram/webhook/route.ts`'s `handleApprovalCallback`
 * and the console approvals page's server-side actions import this one
 * function).
 *
 * MUST be called ONLY after the caller's own `resolveApproval` pending->
 * resolved flip has already succeeded (that guard IS this function's
 * idempotency: a duplicate call — a redelivered Telegram callback, or a
 * double-submitted console action — never reaches here a second time, see
 * each call site) and ONLY when the approval carries a `queueEntryId` —
 * every other tool approval (create_issue/create_workspace/create_repo) has
 * `queueEntryId: null` and this function is a no-op for them
 * (regression-pinned at each call site).
 *
 * approved: reads estimateUsd/suggestedModel.slug back out of the approval's
 * OWN STORED toolInput (never a caller-supplied value — owner rule:
 * server-derived) and writes them atomically via `confirmAlignmentBrief` —
 * this write is what activates #1333's dormant
 * estimated_budget_usd/model_override threading, REGARDLESS of the resulting
 * state. `confirmAlignmentBrief` re-checks the row's own declared blockers at
 * confirm time and only queues it when none are still unmet, otherwise it
 * stays parked with the dependency's own reason — see that function's
 * doc-comment for the full matrix.
 * denied: `denyAlignmentBrief` — the entry stays parked with an honest
 * denial notice; the revise flow is PR ③.
 *
 * Both db-postgres calls guard `WHERE state = 'parked'` and return `false`
 * (never throw) when they match no row; this function only logs that case —
 * it never surfaces as a caller-visible error, matching every other
 * best-effort side-effect at each call site.
 */
export async function applyAlignmentDecision(
  approval: JaceApprovalRow,
  decision: "approved" | "denied",
  actor?: ApprovalActor
): Promise<void> {
  // The runner proposal boundary historically stored this as a `create_issue`
  // approval with the server-owned dependencyContractId marker. Treat that
  // marker as part of the dedicated dependency seam so an approved candidate
  // cannot resolve successfully and then silently skip issue publication.
  if (
    approval.toolName === "dependency_upgrade_contract" ||
    typeof approval.dependencyContractId === "string"
  ) {
    await applyDependencyUpgradeContractDecision(approval, decision, actor);
    return;
  }
  if (!approval.queueEntryId) return;

  if (decision === "denied") {
    const denied = await denyAlignmentBrief(approval.queueEntryId);
    if (!denied) {
      console.error(
        `[approval-decision] denyAlignmentBrief found no parked queue entry ${approval.queueEntryId} for approval ${approval.id} — already left the parked state, left untouched`
      );
    }
    return;
  }

  const confirmed = extractConfirmedBudgetAndModel(approval.toolInput);
  if (!confirmed) {
    console.error(
      `[approval-decision] approval ${approval.id} carries queueEntryId ${approval.queueEntryId} but its stored toolInput has no usable estimateUsd/suggestedModel.slug — cannot confirm the alignment hold; queue entry stays parked`
    );
    return;
  }

  const flippedQueueEntry = await confirmAlignmentBrief({
    queueEntryId: approval.queueEntryId,
    estimatedBudgetUsd: confirmed.estimatedBudgetUsd,
    modelOverride: confirmed.modelOverride,
    // #1338 PR①: denormalize the classifier's task type onto the queue entry
    // at the exact moment the ceiling itself gets sanctioned.
    taskType: confirmed.taskType,
  });
  if (!flippedQueueEntry) {
    console.error(
      `[approval-decision] confirmAlignmentBrief found no parked queue entry ${approval.queueEntryId} for approval ${approval.id} — already left the parked state, left untouched`
    );
  }
}
