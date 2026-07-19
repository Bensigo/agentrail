import {
  confirmAlignmentBrief,
  denyAlignmentBrief,
  type JaceApprovalRow,
} from "@agentrail/db-postgres";
import { extractConfirmedBudgetAndModel } from "./alignment-brief";

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
  decision: "approved" | "denied"
): Promise<void> {
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
  });
  if (!flippedQueueEntry) {
    console.error(
      `[approval-decision] confirmAlignmentBrief found no parked queue entry ${approval.queueEntryId} for approval ${approval.id} — already left the parked state, left untouched`
    );
  }
}
